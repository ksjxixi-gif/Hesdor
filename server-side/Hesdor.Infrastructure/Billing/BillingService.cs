using System.Text.Json;
using Hesdor.Application.Audit;
using Hesdor.Application.Billing;
using Hesdor.Domain.Billing;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Billing;

public sealed class BillingService : IBillingService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly IAuditWriter _auditWriter;

    public BillingService(ApplicationDbContext dbContext, ITenantContext tenantContext, IDateTimeProvider dateTimeProvider, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _dateTimeProvider = dateTimeProvider;
        _auditWriter = auditWriter;
    }

    public async Task<BillingOperationResult> ActivateManualSubscriptionAsync(ActivateManualSubscriptionCommand command, CancellationToken cancellationToken = default)
    {
        if (!_tenantContext.HasTenant || command.TenantId != _tenantContext.TenantId) return new BillingOperationResult(false, "tenant_context_mismatch");
        var plan = await _dbContext.Plans.SingleOrDefaultAsync(item => item.Code == command.PlanCode && item.IsActive, cancellationToken);
        if (plan is null) return new BillingOperationResult(false, "plan_not_found");
        var now = _dateTimeProvider.UtcNow;
        var current = await _dbContext.Subscriptions.SingleOrDefaultAsync(item => item.TenantId == command.TenantId && item.Status != SubscriptionStatus.Canceled && item.Status != SubscriptionStatus.Expired, cancellationToken);
        if (current is not null)
        {
            current.Status = SubscriptionStatus.Canceled;
            current.CanceledAtUtc = now;
            current.CancellationReason = "Replaced by manual activation";
        }

        var periodEnd = command.BillingCycle == BillingCycle.Annual ? now.AddYears(1) : now.AddMonths(1);
        var subscription = new Subscription
        {
            TenantId = command.TenantId,
            PlanId = plan.Id,
            Status = command.TrialDays > 0 ? SubscriptionStatus.Trialing : SubscriptionStatus.Active,
            BillingCycle = command.BillingCycle,
            Provider = BillingProvider.Manual,
            StartedAtUtc = now,
            CurrentPeriodStartUtc = now,
            CurrentPeriodEndUtc = periodEnd,
            TrialEndsAtUtc = command.TrialDays > 0 ? now.AddDays(command.TrialDays) : null
        };
        _dbContext.Subscriptions.Add(subscription);
        await _auditWriter.RecordAsync(new AuditEventInput(command.TenantId, "billing.subscription.activated", nameof(Subscription), subscription.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return new BillingOperationResult(true, SubscriptionId: subscription.Id);
    }

    public async Task<BillingOperationResult> CancelSubscriptionAsync(CancelSubscriptionCommand command, CancellationToken cancellationToken = default)
    {
        if (!_tenantContext.HasTenant || command.TenantId != _tenantContext.TenantId) return new BillingOperationResult(false, "tenant_context_mismatch");
        var subscription = await _dbContext.Subscriptions.SingleOrDefaultAsync(item => item.TenantId == command.TenantId && item.Status != SubscriptionStatus.Canceled && item.Status != SubscriptionStatus.Expired, cancellationToken);
        if (subscription is null) return new BillingOperationResult(false, "subscription_not_found");
        var now = _dateTimeProvider.UtcNow;
        subscription.CancelAtPeriodEnd = command.AtPeriodEnd;
        subscription.CancellationReason = command.Reason?.Trim();
        if (!command.AtPeriodEnd)
        {
            subscription.Status = SubscriptionStatus.Canceled;
            subscription.CanceledAtUtc = now;
        }
        await _auditWriter.RecordAsync(new AuditEventInput(command.TenantId, "billing.subscription.canceled", nameof(Subscription), subscription.Id.ToString(), Result: command.AtPeriodEnd ? "period_end" : "immediate"), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return new BillingOperationResult(true, SubscriptionId: subscription.Id);
    }

    public async Task<BillingOperationResult> ProcessWebhookAsync(BillingWebhookCommand command, CancellationToken cancellationToken = default)
    {
        if (!_tenantContext.HasTenant || command.TenantId != _tenantContext.TenantId) return new BillingOperationResult(false, "tenant_context_mismatch");
        var existing = await _dbContext.BillingEvents.IgnoreQueryFilters().SingleOrDefaultAsync(item => item.TenantId == command.TenantId && item.Provider == command.Provider && item.ExternalEventId == command.ExternalEventId, cancellationToken);
        if (existing is not null)
        {
            return new BillingOperationResult(true, AlreadyProcessed: true);
        }

        _dbContext.BillingEvents.Add(new BillingEvent
        {
            TenantId = command.TenantId,
            Provider = command.Provider,
            ExternalEventId = command.ExternalEventId,
            EventType = command.EventType,
            PayloadJson = command.PayloadJson,
            Status = BillingEventStatus.Processed,
            ReceivedAtUtc = _dateTimeProvider.UtcNow,
            ProcessedAtUtc = _dateTimeProvider.UtcNow
        });
        await _auditWriter.RecordAsync(new AuditEventInput(command.TenantId, "billing.webhook.processed", nameof(BillingEvent), command.ExternalEventId, Result: "processed", MetadataJson: JsonSerializer.Serialize(new { command.Provider, command.EventType })), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return new BillingOperationResult(true);
    }
}
