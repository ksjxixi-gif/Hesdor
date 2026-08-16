namespace Hesdor.Domain.Authorization;

public sealed class Permission : BaseEntity
{
    public string Code { get; set; } = default!;
    public string Name { get; set; } = default!;
    public string Module { get; set; } = default!;
    public string? Description { get; set; }
}
