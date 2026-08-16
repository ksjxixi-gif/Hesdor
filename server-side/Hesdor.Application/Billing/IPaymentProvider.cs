using Hesdor.Domain.Billing;

namespace Hesdor.Application.Billing;

public sealed record ProviderCustomer(string ExternalReference);

public sealed record ProviderSubscription(string ExternalReference, SubscriptionStatus Status, DateTime CurrentPeriodEndUtc);

public sealed record BillingWebhookCommand(Guid TenantId, BillingProvider Provider, string ExternalEventId, string EventType, string PayloadJson);

public interface IPaymentProvider
{
    BillingProvider Provider { get; }

    Task<ProviderCustomer> CreateCustomerAsync(Guid tenantId, CancellationToken cancellationToken = default);

    Task<ProviderSubscription> CreateSubscriptionAsync(Guid tenantId, Guid planId, BillingCycle billingCycle, CancellationToken cancellationToken = default);

    Task CancelSubscriptionAsync(string externalReference, bool atPeriodEnd, CancellationToken cancellationToken = default);

    Task HandleWebhookAsync(BillingWebhookCommand command, CancellationToken cancellationToken = default);
}
