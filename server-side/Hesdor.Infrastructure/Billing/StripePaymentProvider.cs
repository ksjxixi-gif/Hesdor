using Hesdor.Application.Billing;
using Hesdor.Domain.Billing;
using Stripe;

namespace Hesdor.Infrastructure.Billing;

// Real Stripe calls for customer lifecycle and cancellation. Subscription creation requires a
// Stripe checkout flow (payment method collection) which does not exist yet.
// ponytail: CreateSubscriptionAsync throws until checkout is built — wire Checkout sessions then.
public sealed class StripePaymentProvider : IPaymentProvider
{
    public BillingProvider Provider => BillingProvider.Stripe;

    public async Task<ProviderCustomer> CreateCustomerAsync(Guid tenantId, CancellationToken cancellationToken = default)
    {
        var service = new CustomerService();
        var customer = await service.CreateAsync(new CustomerCreateOptions
        {
            Metadata = new Dictionary<string, string> { ["tenantId"] = tenantId.ToString() }
        }, cancellationToken: cancellationToken);
        return new ProviderCustomer(customer.Id);
    }

    public Task<ProviderSubscription> CreateSubscriptionAsync(Guid tenantId, Guid planId, BillingCycle billingCycle, CancellationToken cancellationToken = default)
    {
        throw new NotSupportedException("Stripe subscription creation requires the checkout flow, which is not implemented yet.");
    }

    public async Task CancelSubscriptionAsync(string externalReference, bool atPeriodEnd, CancellationToken cancellationToken = default)
    {
        var service = new SubscriptionService();
        if (atPeriodEnd)
        {
            await service.UpdateAsync(externalReference, new SubscriptionUpdateOptions { CancelAtPeriodEnd = true }, cancellationToken: cancellationToken);
        }
        else
        {
            await service.CancelAsync(externalReference, new SubscriptionCancelOptions(), cancellationToken: cancellationToken);
        }
    }

    public Task HandleWebhookAsync(BillingWebhookCommand command, CancellationToken cancellationToken = default) => Task.CompletedTask;
}
