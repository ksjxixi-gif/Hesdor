using Hesdor.Application.Billing;
using Hesdor.Domain.Billing;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Billing;

public sealed class EntitlementService : IEntitlementService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly IDateTimeProvider _dateTimeProvider;

    public EntitlementService(ApplicationDbContext dbContext, IDateTimeProvider dateTimeProvider)
    {
        _dbContext = dbContext;
        _dateTimeProvider = dateTimeProvider;
    }

    public async Task<bool> HasFeatureAsync(Guid tenantId, Feature feature, CancellationToken cancellationToken = default)
    {
        var snapshot = await GetSnapshotAsync(tenantId, cancellationToken);
        return snapshot?.EnabledFeatures.Contains(feature) == true;
    }

    public async Task RequireFeatureAsync(Guid tenantId, Feature feature, CancellationToken cancellationToken = default)
    {
        if (!await HasFeatureAsync(tenantId, feature, cancellationToken))
        {
            throw new EntitlementDeniedException($"Feature '{feature}' is not enabled for this organization.");
        }
    }

    public async Task<long?> GetLimitAsync(Guid tenantId, LimitType limit, CancellationToken cancellationToken = default)
    {
        var snapshot = await GetSnapshotAsync(tenantId, cancellationToken);
        return snapshot is not null && snapshot.Limits.TryGetValue(limit, out var value) ? value : null;
    }

    public async Task RequireLimitAsync(Guid tenantId, LimitType limit, long currentUsage, long additionalUsage = 1, CancellationToken cancellationToken = default)
    {
        var limitValue = await GetLimitAsync(tenantId, limit, cancellationToken);
        if (limitValue is null || limitValue < 0)
        {
            return;
        }

        if (currentUsage + additionalUsage > limitValue)
        {
            throw new EntitlementLimitExceededException($"Limit '{limit}' would be exceeded.");
        }
    }

    public async Task<EntitlementSnapshot?> GetSnapshotAsync(Guid tenantId, CancellationToken cancellationToken = default)
    {
        var now = _dateTimeProvider.UtcNow;
        var subscription = await _dbContext.Subscriptions.IgnoreQueryFilters()
            .Where(item => item.TenantId == tenantId)
            .OrderByDescending(item => item.CreatedAtUtc)
            .FirstOrDefaultAsync(cancellationToken);
        if (subscription is null || !IsUsable(subscription, now))
        {
            return null;
        }

        var plan = await _dbContext.Plans.AsNoTracking().SingleOrDefaultAsync(item => item.Id == subscription.PlanId && item.IsActive, cancellationToken);
        if (plan is null)
        {
            return null;
        }

        var enabledFeatures = (await _dbContext.PlanFeatures.AsNoTracking().Where(item => item.PlanId == plan.Id && item.IsEnabled).Select(item => item.Feature).ToArrayAsync(cancellationToken)).ToHashSet();
        var planLimits = await _dbContext.PlanLimits.AsNoTracking().Where(item => item.PlanId == plan.Id).ToDictionaryAsync(item => item.Limit, item => item.Value, cancellationToken);
        var tenantEntitlements = await _dbContext.TenantEntitlements.IgnoreQueryFilters().Where(item => item.TenantId == tenantId && (item.ValidFromUtc == null || item.ValidFromUtc <= now) && (item.ValidToUtc == null || item.ValidToUtc > now)).ToArrayAsync(cancellationToken);
        var featureOverrides = await _dbContext.FeatureOverrides.IgnoreQueryFilters().Where(item => item.TenantId == tenantId && (item.ValidFromUtc == null || item.ValidFromUtc <= now) && (item.ValidToUtc == null || item.ValidToUtc > now)).OrderByDescending(item => item.ValidFromUtc).ThenByDescending(item => item.Id).ToArrayAsync(cancellationToken);
        foreach (var entitlement in tenantEntitlements)
        {
            if (entitlement.IsEnabled) enabledFeatures.Add(entitlement.Feature);
            else enabledFeatures.Remove(entitlement.Feature);
        }
        foreach (var featureOverride in featureOverrides.GroupBy(item => item.Feature).Select(group => group.First()))
        {
            if (featureOverride.IsEnabled) enabledFeatures.Add(featureOverride.Feature);
            else enabledFeatures.Remove(featureOverride.Feature);
        }

        var limitOverrides = await _dbContext.TenantLimitOverrides.IgnoreQueryFilters().Where(item => item.TenantId == tenantId && (item.ValidFromUtc == null || item.ValidFromUtc <= now) && (item.ValidToUtc == null || item.ValidToUtc > now)).OrderByDescending(item => item.ValidFromUtc).ThenByDescending(item => item.Id).ToArrayAsync(cancellationToken);
        foreach (var limitOverride in limitOverrides.GroupBy(item => item.Limit).Select(group => group.First()))
        {
            planLimits[limitOverride.Limit] = limitOverride.Value;
        }

        return new EntitlementSnapshot(tenantId, plan.Code, subscription.Status, subscription.CurrentPeriodEndUtc, enabledFeatures.ToArray(), planLimits);
    }

    private static bool IsUsable(Subscription subscription, DateTime now)
    {
        if (subscription.CancelAtPeriodEnd && subscription.CurrentPeriodEndUtc <= now) return false;
        return subscription.Status switch
        {
            SubscriptionStatus.Active => subscription.CurrentPeriodEndUtc > now,
            SubscriptionStatus.Trialing => subscription.TrialEndsAtUtc is null || subscription.TrialEndsAtUtc > now,
            SubscriptionStatus.PastDue or SubscriptionStatus.GracePeriod => subscription.GracePeriodEndsAtUtc is not null && subscription.GracePeriodEndsAtUtc > now,
            _ => false
        };
    }

}
