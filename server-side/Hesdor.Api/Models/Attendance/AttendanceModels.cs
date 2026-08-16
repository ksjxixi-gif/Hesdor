using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Attendance;

namespace Hesdor.Api.Models.Attendance;

public sealed class CreateAttendancePolicyRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Range(0, 1440)] public int LateGraceMinutes { get; set; }
    [Range(0, 1440)] public int OvertimeGraceMinutes { get; set; }
    public bool RequireClockOut { get; set; } = true;
    public bool DeductBreaks { get; set; } = true;
}

public sealed class CreateWorkScheduleRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(100)] public string TimeZone { get; set; } = "UTC";
    public IReadOnlyCollection<WorkScheduleDayRequest> Days { get; set; } = Array.Empty<WorkScheduleDayRequest>();
}

public sealed class WorkScheduleDayRequest
{
    public DayOfWeek DayOfWeek { get; set; }
    public bool IsWorkingDay { get; set; } = true;
    public TimeSpan StartTimeLocal { get; set; }
    public TimeSpan EndTimeLocal { get; set; }
    [Range(0, 1440)] public int BreakMinutes { get; set; }
}

public sealed class AssignScheduleRequest
{
    [Required] public Guid EmployeeId { get; set; }
    [Required] public Guid WorkScheduleId { get; set; }
    [Required] public Guid AttendancePolicyId { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}

public sealed class RecordAttendanceEventRequestDto
{
    [Required] public Guid EmployeeId { get; set; }
    public AttendanceEventType Type { get; set; }
    public DateTime? OccurredAtUtc { get; set; }
    public AttendanceSource Source { get; set; } = AttendanceSource.Manual;
    public Guid? AccessEventId { get; set; }
    public Guid? LocationId { get; set; }
    public string? ExternalEventId { get; set; }
    public string? Notes { get; set; }
}

public sealed class AdjustAttendanceSessionRequestDto
{
    public DateTime? ClockInAtUtc { get; set; }
    public DateTime? ClockOutAtUtc { get; set; }
    [Required, StringLength(500)] public string Reason { get; set; } = string.Empty;
}

public sealed record AttendanceSessionResponse(
    Guid Id,
    Guid EmployeeId,
    DateOnly WorkDate,
    int Sequence,
    DateTime? ClockInAtUtc,
    DateTime? ClockOutAtUtc,
    int WorkedMinutes,
    int LateMinutes,
    int OvertimeMinutes,
    AttendanceSessionStatus Status,
    AttendanceSource Source);

public sealed record PresenceResponse(
    Guid EmployeeId,
    PresenceState State,
    Guid? LocationId,
    DateTime UpdatedAtUtc);
