namespace Hesdor.Domain.Access;

public sealed class Zone : MultiTenantEntity
{
    public Guid FloorId { get; set; }
    public string Name { get; set; } = default!;
    public string Code { get; set; } = default!;
    public ZoneType Type { get; set; } = ZoneType.General;
}

public enum ZoneType
{
    General = 0,
    Restricted = 1,
    Attendance = 2,
    Emergency = 3
}
