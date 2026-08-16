using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Application.Realtime;
using Hesdor.Application.Work;
using Hesdor.Domain.Identity;
using Hesdor.Domain.People;
using Hesdor.Domain.Work;
using Hesdor.Infrastructure.Persistence;
using Hesdor.Infrastructure.Work;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class WorkServiceTests
{
    [Fact]
    public async Task Task_mutations_append_activity_and_publishable_state_changes()
    {
        var fixture = await WorkFixture.CreateAsync();
        var project = await fixture.Service.CreateProjectAsync(new CreateProjectCommand("M3 project", "Small work surface", ProjectStatus.Active));
        var task = await fixture.Service.CreateTaskAsync(new CreateTaskCommand(project.Value!.Id, null, "Ship task API", null, WorkTaskStatus.Todo, WorkTaskPriority.High, null));

        var assigned = await fixture.Service.AssignTaskAsync(new AssignTaskCommand(task.Value!.Id, fixture.EmployeeId));
        var comment = await fixture.Service.AddTaskCommentAsync(new AddTaskCommentCommand(task.Value.Id, "Ready for review."));
        var updated = await fixture.Service.UpdateTaskAsync(new UpdateTaskCommand(task.Value.Id, null, null, WorkTaskStatus.Done, null, null, false));

        Assert.True(project.Succeeded);
        Assert.True(assigned.Succeeded);
        Assert.True(comment.Succeeded);
        Assert.True(updated.Succeeded);
        Assert.Equal(WorkTaskStatus.Done, updated.Value!.Status);
        Assert.Contains(await fixture.Context.TaskActivities.ToArrayAsync(), activity => activity.Type == TaskActivityType.TaskCreated);
        Assert.Contains(await fixture.Context.TaskActivities.ToArrayAsync(), activity => activity.Type == TaskActivityType.AssigneeAdded);
        Assert.Contains(await fixture.Context.TaskActivities.ToArrayAsync(), activity => activity.Type == TaskActivityType.CommentAdded);
        Assert.Contains(await fixture.Context.TaskActivities.ToArrayAsync(), activity => activity.Type == TaskActivityType.StatusChanged);
    }

    [Fact]
    public async Task Duplicate_task_assignee_is_rejected_without_duplicate_rows()
    {
        var fixture = await WorkFixture.CreateAsync();
        var project = await fixture.Service.CreateProjectAsync(new CreateProjectCommand("M3 project", null, ProjectStatus.Active));
        var task = await fixture.Service.CreateTaskAsync(new CreateTaskCommand(project.Value!.Id, null, "Assign once", null, WorkTaskStatus.Todo, WorkTaskPriority.Normal, null));

        var first = await fixture.Service.AssignTaskAsync(new AssignTaskCommand(task.Value!.Id, fixture.EmployeeId));
        var second = await fixture.Service.AssignTaskAsync(new AssignTaskCommand(task.Value.Id, fixture.EmployeeId));

        Assert.True(first.Succeeded);
        Assert.False(second.Succeeded);
        Assert.Equal("task_assignee_already_exists", second.FailureReason);
        Assert.Single(await fixture.Context.TaskAssignees.ToArrayAsync());
    }

    private sealed class WorkFixture
    {
        private WorkFixture(ApplicationDbContext context, WorkService service, Guid employeeId)
        {
            Context = context;
            Service = service;
            EmployeeId = employeeId;
        }

        public ApplicationDbContext Context { get; }
        public WorkService Service { get; }
        public Guid EmployeeId { get; }

        public static async Task<WorkFixture> CreateAsync()
        {
            var tenantId = Guid.NewGuid();
            var userId = Guid.NewGuid();
            var employeeId = Guid.NewGuid();
            var currentUser = new TestCurrentUser(userId, tenantId);
            var tenantContext = new TestTenantContext(tenantId);
            var clock = new TestClock();
            var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
            var context = new ApplicationDbContext(options, currentUser, tenantContext, clock);
            context.Employees.Add(new Employee { Id = employeeId, TenantId = tenantId, FirstName = "Ada", LastName = "Lovelace", EmployeeNumber = "EMP-1", JobTitle = "Engineer" });
            context.Users.Add(new User { Id = userId, TenantId = tenantId, EmployeeId = employeeId, Email = "ada@hesdor.test", NormalizedEmail = "ADA@HESDOR.TEST", PasswordHash = "hash", DisplayName = "Ada" });
            await context.SaveChangesAsync();
            return new WorkFixture(context, new WorkService(context, tenantContext, currentUser, new TestAuditWriter(), new TestRealtimePublisher()), employeeId);
        }
    }

    private sealed class TestClock : IDateTimeProvider
    {
        public DateTime UtcNow => new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => TenantId != Guid.Empty;
    }

    private sealed class TestCurrentUser(Guid userId, Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => true;
        public Guid? UserId { get; } = userId;
        public Guid TenantId { get; } = tenantId;
        public string? Email => "ada@hesdor.test";
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
