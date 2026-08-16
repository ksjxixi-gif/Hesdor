using System.Text.Json;
using Hesdor.Application.Audit;
using Hesdor.Application.Realtime;
using Hesdor.Application.Work;
using Hesdor.Domain.Work;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Work;

public sealed class WorkService : IWorkService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly IAuditWriter _auditWriter;
    private readonly IRealtimeEventPublisher _realtimeEventPublisher;

    public WorkService(ApplicationDbContext dbContext, ITenantContext tenantContext, ICurrentUserService currentUserService, IAuditWriter auditWriter, IRealtimeEventPublisher realtimeEventPublisher)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _currentUserService = currentUserService;
        _auditWriter = auditWriter;
        _realtimeEventPublisher = realtimeEventPublisher;
    }

    public async Task<WorkOperationResult<Project>> CreateProjectAsync(CreateProjectCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Name))
        {
            return Failure<Project>("project_name_required");
        }

        var actorEmployeeId = await GetActorEmployeeIdAsync(cancellationToken);
        var project = new Project
        {
            TenantId = _tenantContext.TenantId,
            Name = command.Name.Trim(),
            Description = command.Description?.Trim(),
            Status = command.Status,
            CreatedByEmployeeId = actorEmployeeId
        };
        _dbContext.Projects.Add(project);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "project.created", nameof(Project), project.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "project.updated", new { project.Id, project.Name, project.Status }, cancellationToken);
        return Success(project);
    }

    public async Task<WorkOperationResult<Project>> UpdateProjectAsync(UpdateProjectCommand command, CancellationToken cancellationToken = default)
    {
        var project = await _dbContext.Projects.SingleOrDefaultAsync(item => item.Id == command.ProjectId, cancellationToken);
        if (project is null)
        {
            return Failure<Project>("project_not_found");
        }

        if (command.Name is not null) project.Name = command.Name.Trim();
        if (command.Description is not null) project.Description = command.Description.Trim();
        if (command.Status is ProjectStatus status) project.Status = status;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "project.updated", nameof(Project), project.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "project.updated", new { project.Id, project.Name, project.Status }, cancellationToken);
        return Success(project);
    }

    public async Task<WorkOperationResult<WorkTask>> CreateTaskAsync(CreateTaskCommand command, CancellationToken cancellationToken = default)
    {
        if (!await _dbContext.Projects.AnyAsync(project => project.Id == command.ProjectId && project.Status == ProjectStatus.Active, cancellationToken))
        {
            return Failure<WorkTask>("active_project_not_found");
        }
        if (command.ParentTaskId is Guid parentTaskId && !await _dbContext.Tasks.AnyAsync(task => task.Id == parentTaskId && task.ProjectId == command.ProjectId, cancellationToken))
        {
            return Failure<WorkTask>("parent_task_not_found");
        }

        var task = new WorkTask
        {
            TenantId = _tenantContext.TenantId,
            ProjectId = command.ProjectId,
            ParentTaskId = command.ParentTaskId,
            Title = command.Title.Trim(),
            Description = command.Description?.Trim(),
            Status = command.Status,
            Priority = command.Priority,
            DueAtUtc = command.DueAtUtc,
            CreatedByEmployeeId = await GetActorEmployeeIdAsync(cancellationToken),
            CompletedAtUtc = command.Status == WorkTaskStatus.Done ? DateTime.UtcNow : null
        };
        _dbContext.Tasks.Add(task);
        await AddActivityAsync(task.Id, TaskActivityType.TaskCreated, new { task.ProjectId, task.Status, task.Priority }, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "task.created", nameof(WorkTask), task.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "task.created", new { task.Id, task.ProjectId, task.Title }, cancellationToken);
        return Success(task);
    }

    public async Task<WorkOperationResult<WorkTask>> UpdateTaskAsync(UpdateTaskCommand command, CancellationToken cancellationToken = default)
    {
        var task = await _dbContext.Tasks.SingleOrDefaultAsync(item => item.Id == command.TaskId, cancellationToken);
        if (task is null)
        {
            return Failure<WorkTask>("task_not_found");
        }

        var previousStatus = task.Status;
        var previousPriority = task.Priority;
        var previousDueAt = task.DueAtUtc;
        if (command.Title is not null) task.Title = command.Title.Trim();
        if (command.Description is not null) task.Description = command.Description.Trim();
        if (command.Status is WorkTaskStatus status)
        {
            task.Status = status;
            task.CompletedAtUtc = status == WorkTaskStatus.Done ? DateTime.UtcNow : null;
        }
        if (command.Priority is WorkTaskPriority priority) task.Priority = priority;
        if (command.ClearDueAt) task.DueAtUtc = null;
        else if (command.DueAtUtc is DateTime dueAtUtc) task.DueAtUtc = dueAtUtc.ToUniversalTime();

        if (previousStatus != task.Status) await AddActivityAsync(task.Id, TaskActivityType.StatusChanged, new { from = previousStatus, to = task.Status }, cancellationToken);
        if (previousPriority != task.Priority) await AddActivityAsync(task.Id, TaskActivityType.PriorityChanged, new { from = previousPriority, to = task.Priority }, cancellationToken);
        if (previousDueAt != task.DueAtUtc) await AddActivityAsync(task.Id, TaskActivityType.DueDateChanged, new { from = previousDueAt, to = task.DueAtUtc }, cancellationToken);
        await AddActivityAsync(task.Id, TaskActivityType.TaskUpdated, new { task.Title, task.Description }, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "task.updated", nameof(WorkTask), task.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "task.updated", new { task.Id, task.ProjectId, task.Status, task.Priority, task.DueAtUtc }, cancellationToken);
        return Success(task);
    }

    public async Task<WorkOperationResult<TaskAssignee>> AssignTaskAsync(AssignTaskCommand command, CancellationToken cancellationToken = default)
    {
        if (!await _dbContext.Tasks.AnyAsync(task => task.Id == command.TaskId, cancellationToken) || !await _dbContext.Employees.AnyAsync(employee => employee.Id == command.EmployeeId, cancellationToken))
        {
            return Failure<TaskAssignee>("task_or_employee_not_found");
        }
        if (await _dbContext.TaskAssignees.AnyAsync(assignee => assignee.TaskId == command.TaskId && assignee.EmployeeId == command.EmployeeId, cancellationToken))
        {
            return Failure<TaskAssignee>("task_assignee_already_exists");
        }

        var assignee = new TaskAssignee { TenantId = _tenantContext.TenantId, TaskId = command.TaskId, EmployeeId = command.EmployeeId };
        _dbContext.TaskAssignees.Add(assignee);
        await AddActivityAsync(command.TaskId, TaskActivityType.AssigneeAdded, new { command.EmployeeId }, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "task.assignee.added", nameof(TaskAssignee), assignee.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "task.assigned", new { command.TaskId, command.EmployeeId }, cancellationToken);
        return Success(assignee);
    }

    public async Task<WorkOperationResult<bool>> RemoveTaskAssigneeAsync(RemoveTaskAssigneeCommand command, CancellationToken cancellationToken = default)
    {
        var assignee = await _dbContext.TaskAssignees.SingleOrDefaultAsync(item => item.TaskId == command.TaskId && item.EmployeeId == command.EmployeeId, cancellationToken);
        if (assignee is null)
        {
            return Failure<bool>("task_assignee_not_found");
        }

        _dbContext.TaskAssignees.Remove(assignee);
        await AddActivityAsync(command.TaskId, TaskActivityType.AssigneeRemoved, new { command.EmployeeId }, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "task.assignee.removed", nameof(TaskAssignee), assignee.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "task.unassigned", new { command.TaskId, command.EmployeeId }, cancellationToken);
        return Success(true);
    }

    public async Task<WorkOperationResult<TaskComment>> AddTaskCommentAsync(AddTaskCommentCommand command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Body) || !await _dbContext.Tasks.AnyAsync(task => task.Id == command.TaskId, cancellationToken))
        {
            return Failure<TaskComment>("task_not_found_or_comment_empty");
        }

        var actorEmployeeId = await GetActorEmployeeIdAsync(cancellationToken);
        if (actorEmployeeId is not Guid employeeId)
        {
            return Failure<TaskComment>("employee_identity_required");
        }

        var comment = new TaskComment { TenantId = _tenantContext.TenantId, TaskId = command.TaskId, AuthorEmployeeId = employeeId, Body = command.Body.Trim() };
        _dbContext.TaskComments.Add(comment);
        await AddActivityAsync(command.TaskId, TaskActivityType.CommentAdded, new { comment.Id }, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "task.comment.added", nameof(TaskComment), comment.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "task.comment.created", new { command.TaskId, comment.Id }, cancellationToken);
        return Success(comment);
    }

    private async Task AddActivityAsync(Guid taskId, TaskActivityType type, object metadata, CancellationToken cancellationToken)
    {
        _dbContext.TaskActivities.Add(new TaskActivity
        {
            TenantId = _tenantContext.TenantId,
            TaskId = taskId,
            ActorEmployeeId = await GetActorEmployeeIdAsync(cancellationToken),
            Type = type,
            MetadataJson = JsonSerializer.Serialize(metadata)
        });
    }

    private async Task<Guid?> GetActorEmployeeIdAsync(CancellationToken cancellationToken)
    {
        if (_currentUserService.UserId is not Guid userId)
        {
            return null;
        }

        return await _dbContext.Users.IgnoreQueryFilters().Where(user => user.Id == userId && user.TenantId == _tenantContext.TenantId).Select(user => user.EmployeeId).SingleOrDefaultAsync(cancellationToken);
    }

    private static WorkOperationResult<T> Success<T>(T value) => new(true, null, value);
    private static WorkOperationResult<T> Failure<T>(string reason) => new(false, reason);
}
