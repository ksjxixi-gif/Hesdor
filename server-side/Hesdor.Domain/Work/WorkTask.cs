namespace Hesdor.Domain.Work;

public sealed class WorkTask : MultiTenantEntity
{
    public Guid ProjectId { get; set; }
    public Guid? ParentTaskId { get; set; }
    public string Title { get; set; } = default!;
    public string? Description { get; set; }
    public WorkTaskStatus Status { get; set; } = WorkTaskStatus.Todo;
    public WorkTaskPriority Priority { get; set; } = WorkTaskPriority.Normal;
    public DateTime? DueAtUtc { get; set; }
    public Guid? CreatedByEmployeeId { get; set; }
    public DateTime? CompletedAtUtc { get; set; }
}

public enum WorkTaskStatus
{
    Backlog = 0,
    Todo = 1,
    InProgress = 2,
    Blocked = 3,
    Done = 4,
    Cancelled = 5
}

public enum WorkTaskPriority
{
    Low = 0,
    Normal = 1,
    High = 2,
    Urgent = 3
}
