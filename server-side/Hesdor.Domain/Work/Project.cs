namespace Hesdor.Domain.Work;

public sealed class Project : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string? Description { get; set; }
    public ProjectStatus Status { get; set; } = ProjectStatus.Active;
    public Guid? CreatedByEmployeeId { get; set; }
}

public enum ProjectStatus
{
    Active = 0,
    Completed = 1,
    Archived = 2
}
