using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Work;

namespace Hesdor.Api.Models.Work;

public sealed class CreateProjectRequest
{
    [Required, StringLength(200)] public string Name { get; set; } = string.Empty;
    [StringLength(4000)] public string? Description { get; set; }
    public ProjectStatus Status { get; set; } = ProjectStatus.Active;
}

public sealed class UpdateProjectRequest
{
    [StringLength(200)] public string? Name { get; set; }
    [StringLength(4000)] public string? Description { get; set; }
    public ProjectStatus? Status { get; set; }
}

public sealed class CreateTaskRequest
{
    [Required] public Guid ProjectId { get; set; }
    public Guid? ParentTaskId { get; set; }
    [Required, StringLength(300)] public string Title { get; set; } = string.Empty;
    [StringLength(10000)] public string? Description { get; set; }
    public WorkTaskStatus Status { get; set; } = WorkTaskStatus.Todo;
    public WorkTaskPriority Priority { get; set; } = WorkTaskPriority.Normal;
    public DateTime? DueAtUtc { get; set; }
}

public sealed class UpdateTaskRequest
{
    [StringLength(300)] public string? Title { get; set; }
    [StringLength(10000)] public string? Description { get; set; }
    public WorkTaskStatus? Status { get; set; }
    public WorkTaskPriority? Priority { get; set; }
    public DateTime? DueAtUtc { get; set; }
    public bool ClearDueAt { get; set; }
}

public sealed class AssignTaskRequest
{
    [Required] public Guid EmployeeId { get; set; }
}

public sealed class AddTaskCommentRequest
{
    [Required, StringLength(10000)] public string Body { get; set; } = string.Empty;
}

public sealed record ProjectResponse(Guid Id, string Name, string? Description, ProjectStatus Status, Guid? CreatedByEmployeeId, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record TaskResponse(Guid Id, Guid ProjectId, Guid? ParentTaskId, string Title, string? Description, WorkTaskStatus Status, WorkTaskPriority Priority, DateTime? DueAtUtc, Guid? CreatedByEmployeeId, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record TaskAssigneeResponse(Guid Id, Guid TaskId, Guid EmployeeId, DateTime CreatedAtUtc);

public sealed record TaskCommentResponse(Guid Id, Guid TaskId, Guid AuthorEmployeeId, string Body, DateTime CreatedAtUtc, DateTime UpdatedAtUtc);

public sealed record TaskActivityResponse(Guid Id, Guid TaskId, Guid? ActorEmployeeId, TaskActivityType Type, string? MetadataJson, DateTime CreatedAtUtc);
