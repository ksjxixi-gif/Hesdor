namespace Hesdor.Domain.Attendance;

public sealed class AttendanceBreak : MultiTenantEntity
{
    public Guid AttendanceSessionId { get; set; }
    public DateTime StartedAtUtc { get; set; }
    public DateTime? EndedAtUtc { get; set; }
    public int DurationMinutes { get; set; }
}
