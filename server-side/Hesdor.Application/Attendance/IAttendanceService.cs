using Hesdor.Domain.Attendance;
using Hesdor.Domain.Access;

namespace Hesdor.Application.Attendance;

public sealed record RecordAttendanceEventRequest(
    Guid EmployeeId,
    AttendanceEventType Type,
    DateTime OccurredAtUtc,
    AttendanceSource Source,
    Guid? AccessEventId = null,
    Guid? LocationId = null,
    string? ExternalEventId = null,
    string? Notes = null);

public sealed record AttendanceEventResult(
    bool Succeeded,
    string? FailureReason,
    Guid? SessionId,
    DateOnly? WorkDate,
    AttendanceSessionStatus? SessionStatus,
    int WorkedMinutes,
    int LateMinutes,
    int OvertimeMinutes,
    PresenceState PresenceState,
    bool AlreadyProcessed = false);

public sealed record AdjustAttendanceSessionRequest(
    Guid SessionId,
    DateTime? ClockInAtUtc,
    DateTime? ClockOutAtUtc,
    string Reason);

public interface IAttendanceService
{
    Task<AttendanceEventResult> RecordEventAsync(
        RecordAttendanceEventRequest request,
        CancellationToken cancellationToken = default);

    Task<AttendanceEventResult> AdjustSessionAsync(
        AdjustAttendanceSessionRequest request,
        CancellationToken cancellationToken = default);

    Task RecoverPresenceFromAccessEventAsync(
        Guid tenantId,
        AccessEvent accessEvent,
        CancellationToken cancellationToken = default);
}
