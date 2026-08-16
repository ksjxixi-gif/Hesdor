namespace Hesdor.Domain.Billing;

public sealed class TenantEntitlement : MultiTenantEntity
{
    public Feature Feature { get; set; }
    public bool IsEnabled { get; set; }
    public string Source { get; set; } = default!;
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}

public sealed class FeatureOverride : MultiTenantEntity
{
    public Feature Feature { get; set; }
    public bool IsEnabled { get; set; }
    public string Reason { get; set; } = default!;
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}

public sealed class TenantLimitOverride : MultiTenantEntity
{
    public LimitType Limit { get; set; }
    public long Value { get; set; }
    public string Reason { get; set; } = default!;
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}
