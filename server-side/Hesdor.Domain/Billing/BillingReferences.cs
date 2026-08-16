namespace Hesdor.Domain.Billing;

public sealed class BillingCustomer : MultiTenantEntity
{
    public BillingProvider Provider { get; set; }
    public string ExternalReference { get; set; } = default!;
}

public sealed class PaymentProviderReference : MultiTenantEntity
{
    public BillingProvider Provider { get; set; }
    public string ReferenceType { get; set; } = default!;
    public string ExternalReference { get; set; } = default!;
}

public sealed class InvoiceReference : MultiTenantEntity
{
    public BillingProvider Provider { get; set; }
    public string ExternalReference { get; set; } = default!;
    public string Status { get; set; } = default!;
    public DateTime? IssuedAtUtc { get; set; }
    public DateTime? DueAtUtc { get; set; }
}

public sealed class BillingEvent : MultiTenantEntity
{
    public BillingProvider Provider { get; set; }
    public string ExternalEventId { get; set; } = default!;
    public string EventType { get; set; } = default!;
    public string PayloadJson { get; set; } = default!;
    public BillingEventStatus Status { get; set; } = BillingEventStatus.Received;
    public DateTime ReceivedAtUtc { get; set; }
    public DateTime? ProcessedAtUtc { get; set; }
    public string? FailureReason { get; set; }
}
