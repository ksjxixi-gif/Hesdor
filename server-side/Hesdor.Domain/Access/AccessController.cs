namespace Hesdor.Domain.Access;

public sealed class AccessController : MultiTenantEntity
{
    public Guid LocationId { get; set; }
    public string Name { get; set; } = default!;
    public string AdapterKey { get; set; } = default!;
    public string ExternalId { get; set; } = default!;
    public AccessControllerStatus Status { get; set; } = AccessControllerStatus.Pending;
    public DateTime? LastHeartbeatAtUtc { get; set; }
    public string? EdgeId { get; set; }
}

public enum AccessControllerStatus
{
    Pending = 0,
    Online = 1,
    Offline = 2,
    Disabled = 3
}
