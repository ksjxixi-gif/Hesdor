namespace Hesdor.Domain.Attendance;

public sealed class EmployeePresence : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public PresenceState State { get; set; } = PresenceState.OffDuty;
    public Guid? LocationId { get; set; }
    public Guid? LastAttendanceEventId { get; set; }
    public Guid? LastAccessEventId { get; set; }
}

public enum PresenceState
{
    InOffice = 0,
    Remote = 1,
    OnBreak = 2,
    Away = 3,
    OffDuty = 4
}
