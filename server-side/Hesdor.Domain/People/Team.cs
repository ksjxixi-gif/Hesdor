namespace Hesdor.Domain.People;

public sealed class Team : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string? Description { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamLeadEmployeeId { get; set; }
}