namespace Hesdor.Domain.Attendance;

public sealed class AttendanceSession : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public DateOnly WorkDate { get; set; }
    public int Sequence { get; set; }
    public DateTime? ClockInAtUtc { get; set; }
    public DateTime? ClockOutAtUtc { get; set; }
    public int WorkedMinutes { get; set; }
    public int LateMinutes { get; set; }
    public int OvertimeMinutes { get; set; }
    public AttendanceSessionStatus Status { get; set; } = AttendanceSessionStatus.Open;
    public AttendanceSource Source { get; set; } = AttendanceSource.Nfc;
}

public enum AttendanceSessionStatus
{
    Open = 0,
    Completed = 1,
    Adjusted = 2,
    Invalid = 3
}
