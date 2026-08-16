using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Access;

namespace Hesdor.Api.Models.Edge;

public sealed class RegisterEdgeRequest
{
    [Required] public Guid LocationId { get; set; }
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(200)] public string ExternalId { get; set; } = string.Empty;
}

public sealed class EdgeHeartbeatRequest
{
    [StringLength(80)] public string? AgentVersion { get; set; }
}

public sealed class EdgeEventBatchRequest
{
    [Required, MinLength(1), MaxLength(500)] public IReadOnlyCollection<EdgeEventRequest> Events { get; set; } = Array.Empty<EdgeEventRequest>();
}

public sealed class EdgeEventRequest
{
    [Required, StringLength(200)] public string ExternalEventId { get; set; } = string.Empty;
    [Required] public Guid DoorId { get; set; }
    [StringLength(320)] public string? CredentialIdentifier { get; set; }
    public Guid? ReaderId { get; set; }
    public AccessDecision Decision { get; set; }
    [Required, StringLength(300)] public string Reason { get; set; } = string.Empty;
    public DateTime OccurredAtUtc { get; set; }
    [StringLength(4000)] public string? MetadataJson { get; set; }
}

public sealed record EdgeRegistrationResponse(
    Guid EdgeAgentId,
    string ExternalId,
    string ApiKey,
    DateTime RegisteredAtUtc);
