using Hesdor.Domain.Billing;

namespace Hesdor.Application.Billing;

public sealed record ActivateManualSubscriptionCommand(Guid TenantId, string PlanCode, BillingCycle BillingCycle, int TrialDays = 0);

public sealed record CancelSubscriptionCommand(Guid TenantId, bool AtPeriodEnd, string? Reason);

public sealed record BillingOperationResult(bool Succeeded, string? FailureReason = null, Guid? SubscriptionId = null, bool AlreadyProcessed = false);

public interface IBillingService
{
    Task<BillingOperationResult> ActivateManualSubscriptionAsync(ActivateManualSubscriptionCommand command, CancellationToken cancellationToken = default);

    Task<BillingOperationResult> CancelSubscriptionAsync(CancelSubscriptionCommand command, CancellationToken cancellationToken = default);

    Task<BillingOperationResult> ProcessWebhookAsync(BillingWebhookCommand command, CancellationToken cancellationToken = default);
}
