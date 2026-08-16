namespace Hesdor.Domain.Access;

public sealed class Floor : MultiTenantEntity
{
    public Guid BuildingId { get; set; }
    public string Name { get; set; } = default!;
    public int Level { get; set; }
}
