namespace Hesdor.Domain.Access;

public sealed class AccessEvent : MultiTenantEntity
{
    public Guid? CredentialId { get; set; }
    public Guid? EmployeeId { get; set; }
    public Guid DoorId { get; set; }
    public Guid? ReaderId { get; set; }
    public AccessDecision Decision { get; set; }
    public string Reason { get; set; } = default!;
    public AccessEventSource Source { get; set; } = AccessEventSource.Controller;
    public string? ExternalEventId { get; set; }
    public DateTime OccurredAtUtc { get; set; }
    public string? MetadataJson { get; set; }
}

public enum AccessDecision
{
    Granted = 0,
    Denied = 1,
    UnknownCredential = 2,
    ExpiredCredential = 3,
    EmployeeInactive = 4,
    OutsideSchedule = 5,
    TemporaryGrant = 6,
    DeviceOffline = 7
}

public enum AccessEventSource
{
    Controller = 0,
    Edge = 1,
    Admin = 2,
    Mobile = 3,
    Imported = 4
}
