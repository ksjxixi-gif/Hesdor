namespace Hesdor.Domain.Access;

public sealed class Building : MultiTenantEntity
{
    public Guid LocationId { get; set; }
    public string Name { get; set; } = default!;
    public string Code { get; set; } = default!;
}
