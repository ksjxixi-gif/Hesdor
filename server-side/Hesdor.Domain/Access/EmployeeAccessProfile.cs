namespace Hesdor.Domain.Access;

public sealed class EmployeeAccessProfile : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid AccessProfileId { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}
