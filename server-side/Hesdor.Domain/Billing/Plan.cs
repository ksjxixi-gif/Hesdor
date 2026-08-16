namespace Hesdor.Domain.Billing;

public sealed class Plan : BaseEntity
{
    public string Code { get; set; } = default!;
    public string Name { get; set; } = default!;
    public decimal MonthlyPrice { get; set; }
    public decimal AnnualPrice { get; set; }
    public string CurrencyCode { get; set; } = "USD";
    public bool IsActive { get; set; } = true;
}

public sealed class PlanFeature : BaseEntity
{
    public Guid PlanId { get; set; }
    public Feature Feature { get; set; }
    public bool IsEnabled { get; set; }
}

public sealed class PlanLimit : BaseEntity
{
    public Guid PlanId { get; set; }
    public LimitType Limit { get; set; }
    public long Value { get; set; }
}
