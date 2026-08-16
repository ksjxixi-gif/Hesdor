using Hesdor.Domain.Access;

namespace Hesdor.Application.Access;

public sealed record AccessDecisionRequest(
    string CredentialIdentifier,
    Guid DoorId,
    DateTime OccurredAtUtc,
    Guid? ReaderId = null,
    AccessEventSource Source = AccessEventSource.Controller,
    string? ExternalEventId = null,
    string? MetadataJson = null);

public sealed record AccessDecisionResult(
    bool IsAllowed,
    AccessDecision Decision,
    string Reason,
    Guid? CredentialId,
    Guid? EmployeeId,
    Guid DoorId,
    DateTime EvaluatedAtUtc);

public interface IAccessPolicyEvaluator
{
    Task<AccessDecisionResult> EvaluateAsync(
        AccessDecisionRequest request,
        CancellationToken cancellationToken = default);
}
