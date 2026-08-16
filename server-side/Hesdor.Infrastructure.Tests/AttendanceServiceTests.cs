using Hesdor.Application.Attendance;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Application.Realtime;
using Hesdor.Domain.Access;
using Hesdor.Domain.Attendance;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Attendance;
using Hesdor.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class AttendanceServiceTests
{
    [Fact]
    public async Task Clock_in_and_clock_out_calculate_lateness_and_overtime()
    {
        var fixture = await AttendanceFixture.CreateAsync();

        var clockIn = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(9, 15), AttendanceSource.Manual));
        var clockOut = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockOut, fixture.Date(18, 10), AttendanceSource.Manual));

        Assert.True(clockIn.Succeeded);
        Assert.Equal(10, clockIn.LateMinutes);
        Assert.True(clockOut.Succeeded);
        Assert.Equal(535, clockOut.WorkedMinutes);
        Assert.Equal(60, clockOut.OvertimeMinutes);
        Assert.Equal(PresenceState.OffDuty, clockOut.PresenceState);
    }

    [Fact]
    public async Task Breaks_are_deducted_and_presence_transitions()
    {
        var fixture = await AttendanceFixture.CreateAsync();

        await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(9, 0), AttendanceSource.Manual));
        var breakStart = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.BreakStart, fixture.Date(12, 0), AttendanceSource.Manual));
        var breakEnd = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.BreakEnd, fixture.Date(12, 30), AttendanceSource.Manual));
        var clockOut = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockOut, fixture.Date(17, 30), AttendanceSource.Manual));

        Assert.Equal(PresenceState.OnBreak, breakStart.PresenceState);
        Assert.Equal(PresenceState.InOffice, breakEnd.PresenceState);
        Assert.Equal(480, clockOut.WorkedMinutes);
    }

    [Fact]
    public async Task External_attendance_event_is_idempotent()
    {
        var fixture = await AttendanceFixture.CreateAsync();
        var request = new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(9, 0), AttendanceSource.Imported, ExternalEventId: "event-1");

        var first = await fixture.Service.RecordEventAsync(request);
        var second = await fixture.Service.RecordEventAsync(request);

        Assert.True(first.Succeeded);
        Assert.True(second.Succeeded);
        Assert.True(second.AlreadyProcessed);
        Assert.Equal(first.SessionId, second.SessionId);
        Assert.Equal(1, await fixture.Context.AttendanceEvents.CountAsync());
    }

    [Fact]
    public async Task Inactive_employee_cannot_clock_in()
    {
        var fixture = await AttendanceFixture.CreateAsync(employmentStatus: EmploymentStatus.Terminated);

        var result = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(9, 0), AttendanceSource.Manual));

        Assert.False(result.Succeeded);
        Assert.Equal("employee_inactive", result.FailureReason);
    }

    [Fact]
    public async Task Overnight_schedule_keeps_work_date_on_clock_in_date()
    {
        var fixture = await AttendanceFixture.CreateAsync(startTime: new TimeSpan(22, 0, 0), endTime: new TimeSpan(6, 0, 0));

        var clockIn = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(22, 0), AttendanceSource.Manual));
        var clockOut = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockOut, fixture.Date(6, 0).AddDays(1), AttendanceSource.Manual));

        Assert.True(clockIn.Succeeded);
        Assert.Equal(new DateOnly(2026, 1, 5), clockIn.WorkDate);
        Assert.Equal(480, clockOut.WorkedMinutes);
        Assert.Equal(0, clockOut.OvertimeMinutes);
    }

    [Fact]
    public async Task Same_start_assignment_uses_the_highest_assignment_id_deterministically()
    {
        var fixture = await AttendanceFixture.CreateAsync();
        var secondScheduleId = Guid.NewGuid();
        var secondPolicyId = Guid.NewGuid();
        var secondAssignmentId = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
        fixture.Context.AttendancePolicies.Add(new AttendancePolicy { Id = secondPolicyId, TenantId = fixture.TenantId, Name = "Early", LateGraceMinutes = 0 });
        fixture.Context.WorkSchedules.Add(new WorkSchedule { Id = secondScheduleId, TenantId = fixture.TenantId, Name = "Early schedule", TimeZone = "UTC" });
        fixture.Context.WorkScheduleDays.Add(new WorkScheduleDay { TenantId = fixture.TenantId, WorkScheduleId = secondScheduleId, DayOfWeek = DayOfWeek.Monday, StartTimeLocal = new TimeSpan(8, 0, 0), EndTimeLocal = new TimeSpan(16, 0, 0) });
        fixture.Context.ScheduleAssignments.Add(new ScheduleAssignment { Id = secondAssignmentId, TenantId = fixture.TenantId, EmployeeId = fixture.EmployeeId, WorkScheduleId = secondScheduleId, AttendancePolicyId = secondPolicyId, ValidFromUtc = fixture.BaseDate.AddDays(-1) });
        await fixture.Context.SaveChangesAsync();

        var result = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(8, 5), AttendanceSource.Manual));

        Assert.True(result.Succeeded);
        Assert.Equal(5, result.LateMinutes);
    }

    [Fact]
    public async Task Manual_adjustment_is_recorded_and_recalculates_session()
    {
        var fixture = await AttendanceFixture.CreateAsync();
        await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockIn, fixture.Date(9, 0), AttendanceSource.Manual));
        var clockOut = await fixture.Service.RecordEventAsync(new RecordAttendanceEventRequest(fixture.EmployeeId, AttendanceEventType.ClockOut, fixture.Date(17, 0), AttendanceSource.Manual));

        var adjusted = await fixture.Service.AdjustSessionAsync(new AdjustAttendanceSessionRequest(clockOut.SessionId!.Value, null, fixture.Date(18, 0), "Approved overtime"));

        Assert.True(adjusted.Succeeded);
        Assert.Equal(50, adjusted.OvertimeMinutes);
        Assert.Equal(AttendanceSessionStatus.Adjusted, adjusted.SessionStatus);
        Assert.Single(await fixture.Context.AttendanceAdjustments.ToArrayAsync());
        Assert.Contains(await fixture.Context.AttendanceEvents.ToArrayAsync(), item => item.Type == AttendanceEventType.ManualAdjustment);
    }

    [Fact]
    public async Task Granted_entrance_access_recovers_presence_after_reconnect()
    {
        var fixture = await AttendanceFixture.CreateAsync();
        var zoneId = Guid.NewGuid();
        var doorId = Guid.NewGuid();
        fixture.Context.Zones.Add(new Zone { Id = zoneId, TenantId = fixture.TenantId, FloorId = Guid.NewGuid(), Name = "Lobby", Code = "LOBBY" });
        fixture.Context.Doors.Add(new Door { Id = doorId, TenantId = fixture.TenantId, ZoneId = zoneId, Name = "Entrance", Code = "ENTRANCE", Type = DoorType.SiteEntrance });
        var accessEvent = new AccessEvent { TenantId = fixture.TenantId, EmployeeId = fixture.EmployeeId, DoorId = doorId, Decision = AccessDecision.Granted, Reason = "policy_granted", OccurredAtUtc = fixture.Date(8, 55) };
        fixture.Context.AccessEvents.Add(accessEvent);
        await fixture.Context.SaveChangesAsync();

        await fixture.Service.RecoverPresenceFromAccessEventAsync(fixture.TenantId, accessEvent);
        await fixture.Context.SaveChangesAsync();
        var presence = await fixture.Context.EmployeePresence.SingleAsync(item => item.EmployeeId == fixture.EmployeeId);

        Assert.Equal(PresenceState.InOffice, presence.State);
        Assert.Equal(accessEvent.Id, presence.LastAccessEventId);
    }

    private sealed class AttendanceFixture
    {
        private AttendanceFixture(ApplicationDbContext context, AttendanceService service, Guid employeeId, DateTime baseDate)
        {
            Context = context;
            Service = service;
            EmployeeId = employeeId;
            BaseDate = baseDate;
        }

        public ApplicationDbContext Context { get; }
        public AttendanceService Service { get; }
        public Guid EmployeeId { get; }
        public DateTime BaseDate { get; }
        public Guid TenantId => Context.CurrentTenantId;

        public DateTime Date(int hour, int minute) => new(BaseDate.Year, BaseDate.Month, BaseDate.Day, hour, minute, 0, DateTimeKind.Utc);

        public static async Task<AttendanceFixture> CreateAsync(EmploymentStatus employmentStatus = EmploymentStatus.Active, TimeSpan? startTime = null, TimeSpan? endTime = null)
        {
            var tenantId = Guid.NewGuid();
            var employeeId = Guid.NewGuid();
            var scheduleId = Guid.NewGuid();
            var policyId = Guid.NewGuid();
            var baseDate = new DateTime(2026, 1, 5, 0, 0, 0, DateTimeKind.Utc);
            var clock = new TestClock();
            var currentUser = new TestCurrentUser(tenantId);
            var tenantContext = new TestTenantContext(tenantId);
            var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
            var context = new ApplicationDbContext(options, currentUser, tenantContext, clock);
            context.Employees.Add(new Employee
            {
                Id = employeeId,
                TenantId = tenantId,
                FirstName = "Ada",
                LastName = "Lovelace",
                EmployeeNumber = "EMP-1",
                JobTitle = "Engineer",
                EmploymentStatus = employmentStatus
            });
            context.AttendancePolicies.Add(new AttendancePolicy
            {
                Id = policyId,
                TenantId = tenantId,
                Name = "Standard",
                LateGraceMinutes = 5,
                OvertimeGraceMinutes = 10
            });
            context.WorkSchedules.Add(new WorkSchedule { Id = scheduleId, TenantId = tenantId, Name = "Sun-Thu", TimeZone = "UTC" });
            context.WorkScheduleDays.Add(new WorkScheduleDay
            {
                TenantId = tenantId,
                WorkScheduleId = scheduleId,
                DayOfWeek = DayOfWeek.Monday,
                StartTimeLocal = startTime ?? new TimeSpan(9, 0, 0),
                EndTimeLocal = endTime ?? new TimeSpan(17, 0, 0),
                BreakMinutes = 30
            });
            context.ScheduleAssignments.Add(new ScheduleAssignment
            {
                TenantId = tenantId,
                EmployeeId = employeeId,
                WorkScheduleId = scheduleId,
                AttendancePolicyId = policyId,
                ValidFromUtc = baseDate.AddDays(-1)
            });
            await context.SaveChangesAsync();
            return new AttendanceFixture(context, new AttendanceService(context, tenantContext, clock, new TestAuditWriter(), new TestRealtimePublisher(), currentUser), employeeId, baseDate);
        }
    }

    private sealed class TestClock : IDateTimeProvider
    {
        public DateTime UtcNow => new(2026, 1, 5, 12, 0, 0, DateTimeKind.Utc);
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => TenantId != Guid.Empty;
    }

    private sealed class TestCurrentUser(Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => false;
        public Guid? UserId => null;
        public Guid TenantId { get; } = tenantId;
        public string? Email => null;
        public IReadOnlyCollection<string> Roles => Array.Empty<string>();
        public bool HasPermission(string permission) => false;
    }

    private sealed class TestAuditWriter : IAuditWriter
    {
        public Task RecordAsync(AuditEventInput input, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class TestRealtimePublisher : IRealtimeEventPublisher
    {
        public Task PublishAsync(Guid tenantId, string eventName, object payload, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task PublishToConversationAsync(Guid tenantId, Guid conversationId, string eventName, object payload, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
