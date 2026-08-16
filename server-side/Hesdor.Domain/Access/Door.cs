namespace Hesdor.Domain.Access;

public sealed class Door : MultiTenantEntity
{
    public Guid ZoneId { get; set; }
    public string Name { get; set; } = default!;
    public string Code { get; set; } = default!;
    public DoorType Type { get; set; } = DoorType.Internal;
    public DoorStatus Status { get; set; } = DoorStatus.Active;
    public bool AffectsAttendance { get; set; }
}

public enum DoorType
{
    SiteEntrance = 0,
    SiteExit = 1,
    Internal = 2,
    RestrictedZone = 3
}

public enum DoorStatus
{
    Active = 0,
    Disabled = 1,
    ForcedOpen = 2,
    Offline = 3
}
