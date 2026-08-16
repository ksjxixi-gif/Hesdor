namespace Hesdor.Domain.Work;

public sealed class TaskComment : MultiTenantEntity
{
    public Guid TaskId { get; set; }
    public Guid AuthorEmployeeId { get; set; }
    public string Body { get; set; } = default!;
}
