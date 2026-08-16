namespace Hesdor.Domain.Work;

public sealed class TaskActivity : MultiTenantEntity
{
    public Guid TaskId { get; set; }
    public Guid? ActorEmployeeId { get; set; }
    public TaskActivityType Type { get; set; }
    public string? MetadataJson { get; set; }
}

public enum TaskActivityType
{
    TaskCreated = 0,
    AssigneeAdded = 1,
    AssigneeRemoved = 2,
    StatusChanged = 3,
    PriorityChanged = 4,
    DueDateChanged = 5,
    CommentAdded = 6,
    TaskUpdated = 7
}
