using Hesdor.Application.Billing;
using Hesdor.Domain.Billing;

namespace Hesdor.Infrastructure.Billing;

public sealed class ManualPaymentProvider : IPaymentProvider
{
    public BillingProvider Provider => BillingProvider.Manual;

    public Task<ProviderCustomer> CreateCustomerAsync(Guid tenantId, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(new ProviderCustomer($"manual:{tenantId:N}"));
    }

    public Task<ProviderSubscription> CreateSubscriptionAsync(Guid tenantId, Guid planId, BillingCycle billingCycle, CancellationToken cancellationToken = default)
    {
        var periodEnd = billingCycle == BillingCycle.Annual ? DateTime.UtcNow.AddYears(1) : DateTime.UtcNow.AddMonths(1);
        return Task.FromResult(new ProviderSubscription($"manual:{tenantId:N}:{planId:N}", SubscriptionStatus.Active, periodEnd));
    }

    public Task CancelSubscriptionAsync(string externalReference, bool atPeriodEnd, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task HandleWebhookAsync(BillingWebhookCommand command, CancellationToken cancellationToken = default) => Task.CompletedTask;
}
