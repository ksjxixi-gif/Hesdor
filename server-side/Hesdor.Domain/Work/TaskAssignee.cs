namespace Hesdor.Domain.Work;

public sealed class TaskAssignee : MultiTenantEntity
{
    public Guid TaskId { get; set; }
    public Guid EmployeeId { get; set; }
}
