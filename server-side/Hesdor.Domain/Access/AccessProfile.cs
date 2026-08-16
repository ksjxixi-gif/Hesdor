namespace Hesdor.Domain.Access;

public sealed class AccessProfile : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string? Description { get; set; }
    public bool IsSystemProfile { get; set; }
}
