namespace Hesdor.Domain.Access;

public sealed class EdgeAgent : MultiTenantEntity
{
    public Guid LocationId { get; set; }
    public string Name { get; set; } = default!;
    public string ExternalId { get; set; } = default!;
    public string CredentialHash { get; set; } = default!;
    public EdgeAgentStatus Status { get; set; } = EdgeAgentStatus.Active;
    public string? AgentVersion { get; set; }
    public long ConfigVersion { get; set; }
    public DateTime RegisteredAtUtc { get; set; }
    public DateTime? LastHeartbeatAtUtc { get; set; }
}

public enum EdgeAgentStatus
{
    Active = 0,
    Disabled = 1,
    Revoked = 2
}
