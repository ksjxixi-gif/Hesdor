using Hesdor.Domain.Billing;

namespace Hesdor.Application.Billing;

public sealed record EntitlementSnapshot(
    Guid TenantId,
    string PlanCode,
    SubscriptionStatus SubscriptionStatus,
    DateTime CurrentPeriodEndUtc,
    IReadOnlyCollection<Feature> EnabledFeatures,
    IReadOnlyDictionary<LimitType, long> Limits);

public sealed class EntitlementDeniedException(string message) : Exception(message);

public sealed class EntitlementLimitExceededException(string message) : Exception(message);

public interface IEntitlementService
{
    Task<bool> HasFeatureAsync(Guid tenantId, Feature feature, CancellationToken cancellationToken = default);

    Task RequireFeatureAsync(Guid tenantId, Feature feature, CancellationToken cancellationToken = default);

    Task<long?> GetLimitAsync(Guid tenantId, LimitType limit, CancellationToken cancellationToken = default);

    Task RequireLimitAsync(Guid tenantId, LimitType limit, long currentUsage, long additionalUsage = 1, CancellationToken cancellationToken = default);

    Task<EntitlementSnapshot?> GetSnapshotAsync(Guid tenantId, CancellationToken cancellationToken = default);
}
