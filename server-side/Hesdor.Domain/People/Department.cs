namespace Hesdor.Domain.People;

public sealed class Department : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string? Description { get; set; }
    public Guid? ParentDepartmentId { get; set; }
}