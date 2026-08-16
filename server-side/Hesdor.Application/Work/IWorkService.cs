using Hesdor.Domain.Work;

namespace Hesdor.Application.Work;

public sealed record WorkOperationResult<T>(bool Succeeded, string? FailureReason, T? Value = default);

public sealed record CreateProjectCommand(string Name, string? Description, ProjectStatus Status);

public sealed record UpdateProjectCommand(Guid ProjectId, string? Name, string? Description, ProjectStatus? Status);

public sealed record CreateTaskCommand(Guid ProjectId, Guid? ParentTaskId, string Title, string? Description, WorkTaskStatus Status, WorkTaskPriority Priority, DateTime? DueAtUtc);

public sealed record UpdateTaskCommand(Guid TaskId, string? Title, string? Description, WorkTaskStatus? Status, WorkTaskPriority? Priority, DateTime? DueAtUtc, bool ClearDueAt);

public sealed record AssignTaskCommand(Guid TaskId, Guid EmployeeId);

public sealed record RemoveTaskAssigneeCommand(Guid TaskId, Guid EmployeeId);

public sealed record AddTaskCommentCommand(Guid TaskId, string Body);

public interface IWorkService
{
    Task<WorkOperationResult<Project>> CreateProjectAsync(CreateProjectCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<Project>> UpdateProjectAsync(UpdateProjectCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<WorkTask>> CreateTaskAsync(CreateTaskCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<WorkTask>> UpdateTaskAsync(UpdateTaskCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<TaskAssignee>> AssignTaskAsync(AssignTaskCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<bool>> RemoveTaskAssigneeAsync(RemoveTaskAssigneeCommand command, CancellationToken cancellationToken = default);
    Task<WorkOperationResult<TaskComment>> AddTaskCommentAsync(AddTaskCommentCommand command, CancellationToken cancellationToken = default);
}
