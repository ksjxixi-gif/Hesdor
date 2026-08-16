namespace Hesdor.Domain.Attendance;

public sealed class ScheduleAssignment : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid WorkScheduleId { get; set; }
    public Guid AttendancePolicyId { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}
