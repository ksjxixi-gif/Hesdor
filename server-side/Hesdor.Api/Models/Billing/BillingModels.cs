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

public sealed record AdminPlanResponse(Guid Id, string Code, string Name, decimal MonthlyPrice, decimal AnnualPrice, string CurrencyCode, bool IsActive, IReadOnlyCollection<string> Features, IReadOnlyDictionary<string, long> Limits);

public sealed class CreatePlanRequest
{
    [Required, StringLength(40, MinimumLength = 3)] public string Code { get; set; } = string.Empty;
    [Required, StringLength(80)] public string Name { get; set; } = string.Empty;
    [Range(0, 1_000_000)] public decimal MonthlyPrice { get; set; }
    [Range(0, 10_000_000)] public decimal AnnualPrice { get; set; }
    [StringLength(3, MinimumLength = 3)] public string? CurrencyCode { get; set; }
    public bool IsActive { get; set; } = true;
    public IReadOnlyCollection<string> Features { get; set; } = [];
    public IReadOnlyDictionary<string, long> Limits { get; set; } = new Dictionary<string, long>();
}

public sealed class UpdatePlanRequest
{
    [StringLength(80)] public string? Name { get; set; }
    [Range(0, 1_000_000)] public decimal? MonthlyPrice { get; set; }
    [Range(0, 10_000_000)] public decimal? AnnualPrice { get; set; }
    [StringLength(3, MinimumLength = 3)] public string? CurrencyCode { get; set; }
    public bool? IsActive { get; set; }
}

public sealed class UpdatePlanDetailsRequest
{
    public IReadOnlyCollection<string>? Features { get; set; }
    public IReadOnlyDictionary<string, long>? Limits { get; set; }
}
