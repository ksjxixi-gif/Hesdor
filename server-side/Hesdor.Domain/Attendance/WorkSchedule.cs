namespace Hesdor.Domain.Attendance;

public sealed class WorkSchedule : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string TimeZone { get; set; } = "UTC";
    public bool IsActive { get; set; } = true;
}

public sealed class WorkScheduleDay : MultiTenantEntity
{
    public Guid WorkScheduleId { get; set; }
    public DayOfWeek DayOfWeek { get; set; }
    public bool IsWorkingDay { get; set; } = true;
    public TimeSpan StartTimeLocal { get; set; }
    public TimeSpan EndTimeLocal { get; set; }
    public int BreakMinutes { get; set; }
}
