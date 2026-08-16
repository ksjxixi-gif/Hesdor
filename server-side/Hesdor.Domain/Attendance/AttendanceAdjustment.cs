namespace Hesdor.Domain.Attendance;

public sealed class AttendanceAdjustment : MultiTenantEntity
{
    public Guid AttendanceSessionId { get; set; }
    public Guid? ActorUserId { get; set; }
    public string Reason { get; set; } = default!;
    public string? PreviousValue { get; set; }
    public string? NewValue { get; set; }
}
