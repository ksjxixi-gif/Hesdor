namespace Hesdor.Domain.Access;

public sealed class TemporaryAccessGrant : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid? ZoneId { get; set; }
    public Guid? DoorId { get; set; }
    public DateTime ValidFromUtc { get; set; }
    public DateTime ValidToUtc { get; set; }
    public string Reason { get; set; } = default!;
    public bool IsRevoked { get; set; }
    public DateTime? RevokedAtUtc { get; set; }
}
