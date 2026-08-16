namespace Hesdor.Domain.Attendance;

public sealed class AttendancePolicy : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public int LateGraceMinutes { get; set; } = 0;
    public int OvertimeGraceMinutes { get; set; } = 0;
    public bool RequireClockOut { get; set; } = true;
    public bool DeductBreaks { get; set; } = true;
}
