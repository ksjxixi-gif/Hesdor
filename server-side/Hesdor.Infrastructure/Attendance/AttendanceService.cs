using Hesdor.Application.Attendance;
using Hesdor.Application.Audit;
using Hesdor.Application.Realtime;
using Hesdor.Domain.Access;
using Hesdor.Domain.Attendance;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Persistence;
using System.Text.Json;

namespace Hesdor.Infrastructure.Attendance;

public sealed class AttendanceService : IAttendanceService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly IAuditWriter _auditWriter;
    private readonly IRealtimeEventPublisher _realtimeEventPublisher;
    private readonly ICurrentUserService _currentUserService;

    public AttendanceService(ApplicationDbContext dbContext, ITenantContext tenantContext, IDateTimeProvider dateTimeProvider, IAuditWriter auditWriter, IRealtimeEventPublisher realtimeEventPublisher, ICurrentUserService currentUserService)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _dateTimeProvider = dateTimeProvider;
        _auditWriter = auditWriter;
        _realtimeEventPublisher = realtimeEventPublisher;
        _currentUserService = currentUserService;
    }

    public async Task<AttendanceEventResult> RecordEventAsync(RecordAttendanceEventRequest request, CancellationToken cancellationToken = default)
    {
        if (!_tenantContext.HasTenant)
        {
            return Failure("tenant_context_required");
        }

        var occurredAtUtc = NormalizeUtc(request.OccurredAtUtc);
        if (!string.IsNullOrWhiteSpace(request.ExternalEventId))
        {
            var existing = await _dbContext.AttendanceEvents.AsNoTracking().SingleOrDefaultAsync(attendanceEvent => attendanceEvent.ExternalEventId == request.ExternalEventId, cancellationToken);
            if (existing is not null)
            {
                var existingSession = existing.AttendanceSessionId is Guid sessionId
                    ? await _dbContext.AttendanceSessions.AsNoTracking().SingleOrDefaultAsync(session => session.Id == sessionId, cancellationToken)
                    : null;
                var existingPresence = await _dbContext.EmployeePresence.AsNoTracking().SingleOrDefaultAsync(presence => presence.EmployeeId == request.EmployeeId, cancellationToken);
                return ToResult(existingSession, existingPresence?.State ?? PresenceState.OffDuty, true);
            }
        }

        var employee = await _dbContext.Employees.SingleOrDefaultAsync(entity => entity.Id == request.EmployeeId, cancellationToken);
        if (employee is null)
        {
            return Failure("employee_not_found");
        }

        if (employee.EmploymentStatus != EmploymentStatus.Active)
        {
            return Failure("employee_inactive");
        }

        var assignment = await _dbContext.ScheduleAssignments
            .Where(item => item.EmployeeId == employee.Id)
            .Where(item => item.ValidFromUtc == null || item.ValidFromUtc <= occurredAtUtc)
            .Where(item => item.ValidToUtc == null || item.ValidToUtc > occurredAtUtc)
            .OrderByDescending(item => item.ValidFromUtc)
            .ThenByDescending(item => item.Id)
            .FirstOrDefaultAsync(cancellationToken);
        var workDate = await GetWorkDateAsync(occurredAtUtc, assignment, cancellationToken);

        AttendanceSession? session = null;
        AttendanceBreak? attendanceBreak = null;
        var presenceState = PresenceState.OffDuty;

        if (request.Type == AttendanceEventType.ClockIn)
        {
            session = await GetOpenSessionAsync(employee.Id, cancellationToken);
            if (session is null)
            {
                var sequence = await _dbContext.AttendanceSessions
                    .Where(item => item.EmployeeId == employee.Id && item.WorkDate == workDate)
                    .Select(item => (int?)item.Sequence)
                    .MaxAsync(cancellationToken) ?? -1;
                session = new AttendanceSession
                {
                    TenantId = _tenantContext.TenantId,
                    EmployeeId = employee.Id,
                    WorkDate = workDate,
                    Sequence = sequence + 1,
                    ClockInAtUtc = occurredAtUtc,
                    Source = request.Source
                };
                await CalculateScheduleMetricsAsync(session, assignment, cancellationToken);
                _dbContext.AttendanceSessions.Add(session);
            }

            presenceState = PresenceState.InOffice;
        }
        else if (request.Type == AttendanceEventType.ClockOut)
        {
            session = await GetOpenSessionAsync(employee.Id, cancellationToken);
            if (session is null || session.ClockInAtUtc is null)
            {
                return Failure("open_attendance_session_not_found");
            }

            session.ClockOutAtUtc = occurredAtUtc;
            session.Status = AttendanceSessionStatus.Completed;
            await CalculateSessionTotalsAsync(session, assignment, cancellationToken);
            presenceState = PresenceState.OffDuty;
        }
        else if (request.Type == AttendanceEventType.BreakStart)
        {
            session = await GetOpenSessionAsync(employee.Id, cancellationToken);
            if (session is null)
            {
                return Failure("open_attendance_session_not_found");
            }

            var openBreak = await _dbContext.AttendanceBreaks.AnyAsync(item => item.AttendanceSessionId == session.Id && item.EndedAtUtc == null, cancellationToken);
            if (openBreak)
            {
                return Failure("attendance_break_already_open");
            }

            attendanceBreak = new AttendanceBreak { TenantId = _tenantContext.TenantId, AttendanceSessionId = session.Id, StartedAtUtc = occurredAtUtc };
            _dbContext.AttendanceBreaks.Add(attendanceBreak);
            presenceState = PresenceState.OnBreak;
        }
        else if (request.Type == AttendanceEventType.BreakEnd)
        {
            session = await GetOpenSessionAsync(employee.Id, cancellationToken);
            if (session is null)
            {
                return Failure("open_attendance_session_not_found");
            }

            attendanceBreak = await _dbContext.AttendanceBreaks.Where(item => item.AttendanceSessionId == session.Id && item.EndedAtUtc == null).OrderByDescending(item => item.StartedAtUtc).FirstOrDefaultAsync(cancellationToken);
            if (attendanceBreak is null)
            {
                return Failure("open_attendance_break_not_found");
            }

            attendanceBreak.EndedAtUtc = occurredAtUtc;
            attendanceBreak.DurationMinutes = Math.Max(0, (int)(occurredAtUtc - attendanceBreak.StartedAtUtc).TotalMinutes);
            presenceState = PresenceState.InOffice;
        }
        else
        {
            return Failure("manual_adjustments_require_the_adjustment_endpoint");
        }

        var rawEvent = new AttendanceEvent
        {
            TenantId = _tenantContext.TenantId,
            EmployeeId = employee.Id,
            AttendanceSessionId = session?.Id,
            AccessEventId = request.AccessEventId,
            LocationId = request.LocationId,
            Type = request.Type,
            Source = request.Source,
            OccurredAtUtc = occurredAtUtc,
            ExternalEventId = request.ExternalEventId,
            Notes = request.Notes?.Trim()
        };
        _dbContext.AttendanceEvents.Add(rawEvent);

        var presence = await _dbContext.EmployeePresence.SingleOrDefaultAsync(item => item.EmployeeId == employee.Id, cancellationToken);
        if (presence is null)
        {
            presence = new EmployeePresence { TenantId = _tenantContext.TenantId, EmployeeId = employee.Id };
            _dbContext.EmployeePresence.Add(presence);
        }
        presence.State = presenceState;
        presence.LocationId = request.LocationId;
        presence.LastAttendanceEventId = rawEvent.Id;

        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, $"attendance.{request.Type.ToString().ToLowerInvariant()}", nameof(AttendanceEvent), rawEvent.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);

        var eventName = request.Type switch
        {
            AttendanceEventType.ClockIn => "attendance.started",
            AttendanceEventType.ClockOut => "attendance.ended",
            _ => "attendance.updated"
        };
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, eventName, new { EmployeeId = employee.Id, AttendanceSessionId = session?.Id, presence.State, occurredAtUtc }, cancellationToken);
        if (request.Type is AttendanceEventType.ClockIn or AttendanceEventType.ClockOut)
        {
            await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, request.Type == AttendanceEventType.ClockIn ? "employee.entered" : "employee.exited", new { employee.Id, request.LocationId, occurredAtUtc }, cancellationToken);
        }

        return ToResult(session, presence.State);
    }

    private async Task<AttendanceSession?> GetOpenSessionAsync(Guid employeeId, CancellationToken cancellationToken)
    {
        return await _dbContext.AttendanceSessions
            .Where(session => session.EmployeeId == employeeId && session.Status == AttendanceSessionStatus.Open && session.ClockOutAtUtc == null)
            .OrderByDescending(session => session.ClockInAtUtc)
            .FirstOrDefaultAsync(cancellationToken);
    }

    private async Task CalculateScheduleMetricsAsync(AttendanceSession session, ScheduleAssignment? assignment, CancellationToken cancellationToken)
    {
        if (session.ClockInAtUtc is null || assignment is null)
        {
            return;
        }

        var scheduleDay = await _dbContext.WorkScheduleDays.SingleOrDefaultAsync(day => day.WorkScheduleId == assignment.WorkScheduleId && day.DayOfWeek == session.WorkDate.DayOfWeek, cancellationToken);
        var schedule = await _dbContext.WorkSchedules.AsNoTracking().SingleOrDefaultAsync(item => item.Id == assignment.WorkScheduleId, cancellationToken);
        var policy = await _dbContext.AttendancePolicies.AsNoTracking().SingleOrDefaultAsync(item => item.Id == assignment.AttendancePolicyId, cancellationToken);
        if (scheduleDay is null || schedule is null || policy is null || !scheduleDay.IsWorkingDay)
        {
            return;
        }

        var startUtc = LocalToUtc(session.WorkDate, scheduleDay.StartTimeLocal, schedule.TimeZone);
        session.LateMinutes = Math.Max(0, (int)(session.ClockInAtUtc.Value - startUtc.AddMinutes(policy.LateGraceMinutes)).TotalMinutes);
    }

    private async Task CalculateSessionTotalsAsync(AttendanceSession session, ScheduleAssignment? assignment, CancellationToken cancellationToken)
    {
        if (session.ClockInAtUtc is null || session.ClockOutAtUtc is null)
        {
            return;
        }

        var breakMinutes = await _dbContext.AttendanceBreaks.Where(item => item.AttendanceSessionId == session.Id).SumAsync(item => item.DurationMinutes, cancellationToken);
        session.WorkedMinutes = Math.Max(0, (int)(session.ClockOutAtUtc.Value - session.ClockInAtUtc.Value).TotalMinutes - breakMinutes);
        if (assignment is null)
        {
            return;
        }

        var scheduleDay = await _dbContext.WorkScheduleDays.SingleOrDefaultAsync(day => day.WorkScheduleId == assignment.WorkScheduleId && day.DayOfWeek == session.WorkDate.DayOfWeek, cancellationToken);
        var schedule = await _dbContext.WorkSchedules.AsNoTracking().SingleOrDefaultAsync(item => item.Id == assignment.WorkScheduleId, cancellationToken);
        var policy = await _dbContext.AttendancePolicies.AsNoTracking().SingleOrDefaultAsync(item => item.Id == assignment.AttendancePolicyId, cancellationToken);
        if (scheduleDay is null || schedule is null || policy is null || !scheduleDay.IsWorkingDay)
        {
            return;
        }

        var endDate = scheduleDay.EndTimeLocal <= scheduleDay.StartTimeLocal ? session.WorkDate.AddDays(1) : session.WorkDate;
        var endUtc = LocalToUtc(endDate, scheduleDay.EndTimeLocal, schedule.TimeZone);
        session.OvertimeMinutes = Math.Max(0, (int)(session.ClockOutAtUtc.Value - endUtc.AddMinutes(policy.OvertimeGraceMinutes)).TotalMinutes);
    }

    public async Task<AttendanceEventResult> AdjustSessionAsync(AdjustAttendanceSessionRequest request, CancellationToken cancellationToken = default)
    {
        if (!_tenantContext.HasTenant || string.IsNullOrWhiteSpace(request.Reason))
        {
            return Failure("tenant_context_and_reason_required");
        }

        if (request.ClockInAtUtc is null && request.ClockOutAtUtc is null)
        {
            return Failure("at_least_one_session_value_is_required");
        }

        var session = await _dbContext.AttendanceSessions.SingleOrDefaultAsync(item => item.Id == request.SessionId, cancellationToken);
        if (session is null)
        {
            return Failure("attendance_session_not_found");
        }

        var previousValue = JsonSerializer.Serialize(new { session.ClockInAtUtc, session.ClockOutAtUtc, session.WorkedMinutes, session.LateMinutes, session.OvertimeMinutes, session.Status });
        if (request.ClockInAtUtc is DateTime clockInAtUtc)
        {
            session.ClockInAtUtc = NormalizeUtc(clockInAtUtc);
        }
        if (request.ClockOutAtUtc is DateTime clockOutAtUtc)
        {
            session.ClockOutAtUtc = NormalizeUtc(clockOutAtUtc);
        }

        var assignment = await _dbContext.ScheduleAssignments
            .Where(item => item.EmployeeId == session.EmployeeId)
            .Where(item => item.ValidFromUtc == null || item.ValidFromUtc <= (session.ClockInAtUtc ?? _dateTimeProvider.UtcNow))
            .Where(item => item.ValidToUtc == null || item.ValidToUtc > (session.ClockInAtUtc ?? _dateTimeProvider.UtcNow))
            .OrderByDescending(item => item.ValidFromUtc)
            .ThenByDescending(item => item.Id)
            .FirstOrDefaultAsync(cancellationToken);
        await CalculateScheduleMetricsAsync(session, assignment, cancellationToken);
        if (session.ClockOutAtUtc is not null)
        {
            session.Status = AttendanceSessionStatus.Adjusted;
            await CalculateSessionTotalsAsync(session, assignment, cancellationToken);
        }

        var newValue = JsonSerializer.Serialize(new { session.ClockInAtUtc, session.ClockOutAtUtc, session.WorkedMinutes, session.LateMinutes, session.OvertimeMinutes, session.Status });
        _dbContext.AttendanceAdjustments.Add(new AttendanceAdjustment
        {
            TenantId = _tenantContext.TenantId,
            AttendanceSessionId = session.Id,
            ActorUserId = _currentUserService.UserId,
            Reason = request.Reason.Trim(),
            PreviousValue = previousValue,
            NewValue = newValue
        });
        _dbContext.AttendanceEvents.Add(new AttendanceEvent
        {
            TenantId = _tenantContext.TenantId,
            EmployeeId = session.EmployeeId,
            AttendanceSessionId = session.Id,
            Type = AttendanceEventType.ManualAdjustment,
            Source = AttendanceSource.AdminAdjustment,
            OccurredAtUtc = _dateTimeProvider.UtcNow,
            Notes = request.Reason.Trim()
        });
        var presence = await _dbContext.EmployeePresence.SingleOrDefaultAsync(item => item.EmployeeId == session.EmployeeId, cancellationToken);
        if (presence is not null)
        {
            presence.State = session.ClockOutAtUtc is not null ? PresenceState.OffDuty : PresenceState.InOffice;
        }
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "attendance.adjusted", nameof(AttendanceSession), session.Id.ToString(), previousValue, newValue, Hesdor.Domain.Audit.AuditSeverity.Warning, "adjusted"), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "attendance.updated", new { session.Id, session.EmployeeId, session.Status, session.WorkedMinutes, session.LateMinutes, session.OvertimeMinutes }, cancellationToken);
        return ToResult(session, presence?.State ?? PresenceState.OffDuty);
    }

    public async Task RecoverPresenceFromAccessEventAsync(Guid tenantId, AccessEvent accessEvent, CancellationToken cancellationToken = default)
    {
        if (accessEvent.Decision is not (AccessDecision.Granted or AccessDecision.TemporaryGrant) || accessEvent.EmployeeId is not Guid employeeId)
        {
            return;
        }

        var door = await _dbContext.Doors.IgnoreQueryFilters().SingleOrDefaultAsync(item => item.TenantId == tenantId && item.Id == accessEvent.DoorId, cancellationToken);
        if (door is null || door.Type is not (DoorType.SiteEntrance or DoorType.SiteExit))
        {
            return;
        }

        var presence = await _dbContext.EmployeePresence.IgnoreQueryFilters().SingleOrDefaultAsync(item => item.TenantId == tenantId && item.EmployeeId == employeeId, cancellationToken);
        if (presence is null)
        {
            presence = new EmployeePresence { TenantId = tenantId, EmployeeId = employeeId };
            _dbContext.EmployeePresence.Add(presence);
        }

        presence.State = door.Type == DoorType.SiteEntrance ? PresenceState.InOffice : PresenceState.OffDuty;
        presence.LastAccessEventId = accessEvent.Id;
        presence.LocationId = null;
        presence.UpdatedAtUtc = accessEvent.OccurredAtUtc;
    }

    private async Task<DateOnly> GetWorkDateAsync(DateTime occurredAtUtc, ScheduleAssignment? assignment, CancellationToken cancellationToken)
    {
        if (assignment is null)
        {
            return DateOnly.FromDateTime(occurredAtUtc);
        }

        var schedule = await _dbContext.WorkSchedules.AsNoTracking().SingleOrDefaultAsync(item => item.Id == assignment.WorkScheduleId, cancellationToken);
        if (schedule is null)
        {
            return DateOnly.FromDateTime(occurredAtUtc);
        }

        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(occurredAtUtc, FindTimeZone(schedule.TimeZone)));
    }

    private static DateTime LocalToUtc(DateOnly date, TimeSpan time, string timeZoneId)
    {
        var timeZone = FindTimeZone(timeZoneId);
        var local = DateTime.SpecifyKind(date.ToDateTime(TimeOnly.FromTimeSpan(time)), DateTimeKind.Unspecified);
        return TimeZoneInfo.ConvertTimeToUtc(local, timeZone);
    }

    private static TimeZoneInfo FindTimeZone(string timeZoneId)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
        }
        catch (TimeZoneNotFoundException)
        {
            return TimeZoneInfo.Utc;
        }
        catch (InvalidTimeZoneException)
        {
            return TimeZoneInfo.Utc;
        }
    }

    private static DateTime NormalizeUtc(DateTime value)
    {
        return value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
    }

    private static AttendanceEventResult Failure(string reason) => new(false, reason, null, null, null, 0, 0, 0, PresenceState.OffDuty);

    private static AttendanceEventResult ToResult(AttendanceSession? session, PresenceState presenceState, bool alreadyProcessed = false)
    {
        return new AttendanceEventResult(true, null, session?.Id, session?.WorkDate, session?.Status, session?.WorkedMinutes ?? 0, session?.LateMinutes ?? 0, session?.OvertimeMinutes ?? 0, presenceState, alreadyProcessed);
    }
}
