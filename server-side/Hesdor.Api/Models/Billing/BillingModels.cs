using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Billing;

namespace Hesdor.Api.Models.Billing;

public sealed class ActivateManualSubscriptionRequest
{
    [Required, StringLength(80)] public string PlanCode { get; set; } = string.Empty;
    public BillingCycle BillingCycle { get; set; } = BillingCycle.Monthly;
    [Range(0, 90)] public int TrialDays { get; set; }
}

public sealed class CancelSubscriptionRequest
{
    public bool AtPeriodEnd { get; set; } = true;
    [StringLength(500)] public string? Reason { get; set; }
}

public sealed class BillingWebhookRequest
{
    [Required] public Guid TenantId { get; set; }
    public BillingProvider Provider { get; set; }
    [Required, StringLength(320)] public string ExternalEventId { get; set; } = string.Empty;
    [Required, StringLength(160)] public string EventType { get; set; } = string.Empty;
    [Required] public string PayloadJson { get; set; } = string.Empty;
}

public sealed record PlanResponse(Guid Id, string Code, string Name, decimal MonthlyPrice, decimal AnnualPrice, string CurrencyCode);

public sealed record SubscriptionResponse(Guid Id, Guid PlanId, SubscriptionStatus Status, BillingCycle BillingCycle, BillingProvider Provider, DateTime StartedAtUtc, DateTime CurrentPeriodStartUtc, DateTime CurrentPeriodEndUtc, DateTime? TrialEndsAtUtc, DateTime? GracePeriodEndsAtUtc, bool CancelAtPeriodEnd, DateTime? CanceledAtUtc);

public sealed record EntitlementResponse(Guid TenantId, string PlanCode, SubscriptionStatus SubscriptionStatus, DateTime CurrentPeriodEndUtc, IReadOnlyCollection<Feature> EnabledFeatures, IReadOnlyDictionary<LimitType, long> Limits);
