using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Attendance;
using Hesdor.Application.Attendance;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.Attendance;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/attendance")]
public sealed class AttendanceController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAttendanceService _attendanceService;
    private readonly IAuditWriter _auditWriter;

    public AttendanceController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAttendanceService attendanceService, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _attendanceService = attendanceService;
        _auditWriter = auditWriter;
    }

    [HttpGet("sessions")]
    [RequirePermission("attendance.read")]
    public async Task<IActionResult> GetSessions([FromQuery] Guid? employeeId, [FromQuery] DateOnly? workDate, CancellationToken cancellationToken)
    {
        var query = _dbContext.AttendanceSessions.AsNoTracking();
        if (employeeId is Guid employee)
        {
            query = query.Where(session => session.EmployeeId == employee);
        }
        if (workDate is DateOnly date)
        {
            query = query.Where(session => session.WorkDate == date);
        }

        var sessions = await query.OrderByDescending(session => session.WorkDate).ThenByDescending(session => session.ClockInAtUtc).Select(session => new AttendanceSessionResponse(session.Id, session.EmployeeId, session.WorkDate, session.Sequence, session.ClockInAtUtc, session.ClockOutAtUtc, session.WorkedMinutes, session.LateMinutes, session.OvertimeMinutes, session.Status, session.Source)).ToArrayAsync(cancellationToken);
        return Ok(sessions);
    }

    [HttpGet("presence")]
    [RequirePermission("attendance.read")]
    public async Task<IActionResult> GetPresence(CancellationToken cancellationToken)
    {
        var presence = await _dbContext.EmployeePresence.AsNoTracking().OrderBy(item => item.State).ThenBy(item => item.EmployeeId).Select(item => new PresenceResponse(item.EmployeeId, item.State, item.LocationId, item.UpdatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(presence);
    }

    [HttpPost("events")]
    [RequirePermission("attendance.edit")]
    public async Task<IActionResult> RecordEvent(RecordAttendanceEventRequestDto request, CancellationToken cancellationToken)
    {
        var result = await _attendanceService.RecordEventAsync(new Hesdor.Application.Attendance.RecordAttendanceEventRequest(request.EmployeeId, request.Type, request.OccurredAtUtc ?? DateTime.UtcNow, request.Source, request.AccessEventId, request.LocationId, request.ExternalEventId, request.Notes), cancellationToken);
        if (!result.Succeeded)
        {
            return BadRequest(new ProblemDetails { Title = "Attendance event was rejected.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
        }

        return Ok(result);
    }

    [HttpPost("sessions/{id:guid}/adjust")]
    [RequirePermission("attendance.edit")]
    public async Task<IActionResult> AdjustSession(Guid id, AdjustAttendanceSessionRequestDto request, CancellationToken cancellationToken)
    {
        var result = await _attendanceService.AdjustSessionAsync(new Hesdor.Application.Attendance.AdjustAttendanceSessionRequest(id, request.ClockInAtUtc, request.ClockOutAtUtc, request.Reason), cancellationToken);
        if (!result.Succeeded)
        {
            return BadRequest(new ProblemDetails { Title = "Attendance adjustment was rejected.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
        }

        return Ok(result);
    }

    [HttpPost("policies")]
    [RequirePermission("attendance.edit")]
    public async Task<IActionResult> CreatePolicy(CreateAttendancePolicyRequest request, CancellationToken cancellationToken)
    {
        var policy = new AttendancePolicy
        {
            TenantId = _tenantContext.TenantId,
            Name = request.Name.Trim(),
            LateGraceMinutes = request.LateGraceMinutes,
            OvertimeGraceMinutes = request.OvertimeGraceMinutes,
            RequireClockOut = request.RequireClockOut,
            DeductBreaks = request.DeductBreaks
        };
        _dbContext.AttendancePolicies.Add(policy);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "attendance_policy.created", nameof(AttendancePolicy), policy.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/attendance/policies/{policy.Id}", new { policy.Id, policy.Name });
    }

    [HttpPost("schedules")]
    [RequirePermission("attendance.edit")]
    public async Task<IActionResult> CreateSchedule(CreateWorkScheduleRequest request, CancellationToken cancellationToken)
    {
        var schedule = new WorkSchedule { TenantId = _tenantContext.TenantId, Name = request.Name.Trim(), TimeZone = request.TimeZone.Trim() };
        _dbContext.WorkSchedules.Add(schedule);
        _dbContext.WorkScheduleDays.AddRange(request.Days.Select(day => new WorkScheduleDay
        {
            TenantId = _tenantContext.TenantId,
            WorkScheduleId = schedule.Id,
            DayOfWeek = day.DayOfWeek,
            IsWorkingDay = day.IsWorkingDay,
            StartTimeLocal = day.StartTimeLocal,
            EndTimeLocal = day.EndTimeLocal,
            BreakMinutes = day.BreakMinutes
        }));
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "work_schedule.created", nameof(WorkSchedule), schedule.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/attendance/schedules/{schedule.Id}", new { schedule.Id, schedule.Name, schedule.TimeZone });
    }

    [HttpPost("assignments")]
    [RequirePermission("attendance.edit")]
    public async Task<IActionResult> AssignSchedule(AssignScheduleRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Employees.AnyAsync(employee => employee.Id == request.EmployeeId, cancellationToken) || !await _dbContext.WorkSchedules.AnyAsync(schedule => schedule.Id == request.WorkScheduleId, cancellationToken) || !await _dbContext.AttendancePolicies.AnyAsync(policy => policy.Id == request.AttendancePolicyId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Employee, schedule, and policy must belong to this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var assignment = new ScheduleAssignment
        {
            TenantId = _tenantContext.TenantId,
            EmployeeId = request.EmployeeId,
            WorkScheduleId = request.WorkScheduleId,
            AttendancePolicyId = request.AttendancePolicyId,
            ValidFromUtc = request.ValidFromUtc,
            ValidToUtc = request.ValidToUtc
        };
        _dbContext.ScheduleAssignments.Add(assignment);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "schedule_assignment.created", nameof(ScheduleAssignment), assignment.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/attendance/assignments/{assignment.Id}", new { assignment.Id, assignment.EmployeeId, assignment.WorkScheduleId, assignment.AttendancePolicyId });
    }
}
