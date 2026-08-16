namespace Hesdor.Domain.Billing;

public sealed class Subscription : MultiTenantEntity
{
    public Guid PlanId { get; set; }
    public SubscriptionStatus Status { get; set; } = SubscriptionStatus.Trialing;
    public BillingCycle BillingCycle { get; set; } = BillingCycle.Monthly;
    public DateTime StartedAtUtc { get; set; }
    public DateTime CurrentPeriodStartUtc { get; set; }
    public DateTime CurrentPeriodEndUtc { get; set; }
    public DateTime? TrialEndsAtUtc { get; set; }
    public DateTime? GracePeriodEndsAtUtc { get; set; }
    public bool CancelAtPeriodEnd { get; set; }
    public DateTime? CanceledAtUtc { get; set; }
    public string? CancellationReason { get; set; }
    public BillingProvider Provider { get; set; } = BillingProvider.Manual;
}

public sealed class TenantTrial : MultiTenantEntity
{
    public DateTime StartedAtUtc { get; set; }
    public DateTime EndsAtUtc { get; set; }
    public DateTime? ConvertedAtUtc { get; set; }
}
