using Hesdor.Application.Audit;
using Hesdor.Application.Billing;
using Hesdor.Application.Common;
using Hesdor.Domain.Billing;
using Hesdor.Infrastructure.Billing;
using Hesdor.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class BillingTests
{
    [Fact]
    public async Task Expired_trial_disables_features()
    {
        var fixture = await BillingFixture.CreateAsync(SubscriptionStatus.Trialing, new DateTime(2025, 12, 31, 0, 0, 0, DateTimeKind.Utc), null);

        Assert.False(await fixture.Entitlements.HasFeatureAsync(fixture.TenantId, Feature.Messaging));
        Assert.Null(await fixture.Entitlements.GetLimitAsync(fixture.TenantId, LimitType.MaxEmployees));
    }

    [Fact]
    public async Task Grace_period_keeps_plan_entitlements_alive()
    {
        var fixture = await BillingFixture.CreateAsync(SubscriptionStatus.GracePeriod, null, new DateTime(2026, 1, 6, 0, 0, 0, DateTimeKind.Utc));

        Assert.True(await fixture.Entitlements.HasFeatureAsync(fixture.TenantId, Feature.Messaging));
        Assert.Equal(250, await fixture.Entitlements.GetLimitAsync(fixture.TenantId, LimitType.MaxEmployees));
    }

    [Fact]
    public async Task Tenant_override_can_disable_feature_and_raise_limit()
    {
        var fixture = await BillingFixture.CreateAsync(SubscriptionStatus.Active, null, null);
        fixture.Context.FeatureOverrides.Add(new FeatureOverride { TenantId = fixture.TenantId, Feature = Feature.Messaging, IsEnabled = false, Reason = "Contract review" });
        fixture.Context.TenantLimitOverrides.Add(new TenantLimitOverride { TenantId = fixture.TenantId, Limit = LimitType.MaxEmployees, Value = 500, Reason = "Enterprise exception" });
        await fixture.Context.SaveChangesAsync();

        Assert.False(await fixture.Entitlements.HasFeatureAsync(fixture.TenantId, Feature.Messaging));
        Assert.Equal(500, await fixture.Entitlements.GetLimitAsync(fixture.TenantId, LimitType.MaxEmployees));
    }

    [Fact]
    public async Task Cancellation_at_period_end_keeps_subscription_usable_until_end()
    {
        var fixture = await BillingFixture.CreateAsync(SubscriptionStatus.Active, null, null);
        var result = await fixture.Billing.CancelSubscriptionAsync(new CancelSubscriptionCommand(fixture.TenantId, true, "Moving plan"));

        var subscription = await fixture.Context.Subscriptions.SingleAsync();
        Assert.True(result.Succeeded);
        Assert.True(subscription.CancelAtPeriodEnd);
        Assert.Equal(SubscriptionStatus.Active, subscription.Status);
        Assert.True(await fixture.Entitlements.HasFeatureAsync(fixture.TenantId, Feature.Messaging));
    }

    [Fact]
    public async Task Manual_activation_is_provider_agnostic_and_webhook_replay_is_idempotent()
    {
        var fixture = await BillingFixture.CreateAsync(null, null, null, includeSubscription: false);
        var activation = await fixture.Billing.ActivateManualSubscriptionAsync(new ActivateManualSubscriptionCommand(fixture.TenantId, "business", BillingCycle.Manual));
        var webhook = new BillingWebhookCommand(fixture.TenantId, BillingProvider.Manual, "event-1", "invoice.paid", "{}");
        var first = await fixture.Billing.ProcessWebhookAsync(webhook);
        var replay = await fixture.Billing.ProcessWebhookAsync(webhook);

        Assert.True(activation.Succeeded);
        Assert.True(first.Succeeded);
        Assert.True(replay.AlreadyProcessed);
        Assert.Single(await fixture.Context.BillingEvents.ToArrayAsync());
        Assert.Equal(BillingProvider.Manual, (await fixture.Context.Subscriptions.SingleAsync()).Provider);
    }

    private sealed class BillingFixture
    {
        private BillingFixture(ApplicationDbContext context, EntitlementService entitlements, BillingService billing, Guid tenantId)
        {
            Context = context;
            Entitlements = entitlements;
            Billing = billing;
            TenantId = tenantId;
        }

        public ApplicationDbContext Context { get; }
        public EntitlementService Entitlements { get; }
        public BillingService Billing { get; }
        public Guid TenantId { get; }

        public static async Task<BillingFixture> CreateAsync(SubscriptionStatus? status, DateTime? trialEndsAtUtc, DateTime? graceEndsAtUtc, bool includeSubscription = true)
        {
            var tenantId = Guid.NewGuid();
            var currentUser = new TestCurrentUser(tenantId);
            var tenantContext = new TestTenantContext(tenantId);
            var clock = new TestClock();
            var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
            var context = new ApplicationDbContext(options, currentUser, tenantContext, clock);
            await context.Database.EnsureCreatedAsync();
            context.Tenants.Add(new Domain.Organizations.Tenant { Id = tenantId, Name = "Test", Slug = Guid.NewGuid().ToString("N"), Plan = Domain.Organizations.TenantPlan.Business, PlanId = PlanCatalog.BusinessPlanId, Status = Domain.Organizations.TenantStatus.Active });
            if (includeSubscription)
            {
                context.Subscriptions.Add(new Subscription { TenantId = tenantId, PlanId = PlanCatalog.BusinessPlanId, Status = status!.Value, BillingCycle = BillingCycle.Monthly, Provider = BillingProvider.Manual, StartedAtUtc = clock.UtcNow.AddDays(-10), CurrentPeriodStartUtc = clock.UtcNow.AddDays(-10), CurrentPeriodEndUtc = clock.UtcNow.AddDays(20), TrialEndsAtUtc = trialEndsAtUtc, GracePeriodEndsAtUtc = graceEndsAtUtc });
            }
            await context.SaveChangesAsync();
            return new BillingFixture(context, new EntitlementService(context, clock), new BillingService(context, tenantContext, clock, new TestAuditWriter()), tenantId);
        }
    }

    private sealed class TestClock : IDateTimeProvider
    {
        public DateTime UtcNow => new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => true;
    }

    private sealed class TestCurrentUser(Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => true;
        public Guid? UserId => Guid.NewGuid();
        public Guid TenantId { get; } = tenantId;
        public string? Email => "billing@hesdor.test";
        public IReadOnlyCollection<string> Roles => Array.Empty<string>();
        public bool HasPermission(string permission) => true;
    }

    private sealed class TestAuditWriter : IAuditWriter
    {
        public Task RecordAsync(AuditEventInput input, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
