namespace Hesdor.Domain.Authorization;

public sealed class Role : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string? Description { get; set; }
    public bool IsSystemRole { get; set; }
    public int SortOrder { get; set; }
}