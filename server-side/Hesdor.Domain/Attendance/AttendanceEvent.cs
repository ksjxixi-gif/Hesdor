namespace Hesdor.Domain.Attendance;

public sealed class AttendanceEvent : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid? AttendanceSessionId { get; set; }
    public Guid? AccessEventId { get; set; }
    public Guid? LocationId { get; set; }
    public AttendanceEventType Type { get; set; }
    public AttendanceSource Source { get; set; }
    public DateTime OccurredAtUtc { get; set; }
    public string? ExternalEventId { get; set; }
    public string? Notes { get; set; }
}

public enum AttendanceEventType
{
    ClockIn = 0,
    ClockOut = 1,
    BreakStart = 2,
    BreakEnd = 3,
    ManualAdjustment = 4
}

public enum AttendanceSource
{
    Nfc = 0,
    AccessEvent = 1,
    Manual = 2,
    Mobile = 3,
    AdminAdjustment = 4,
    Imported = 5
}
