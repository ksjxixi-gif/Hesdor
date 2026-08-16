namespace Hesdor.Domain.Authorization;

public sealed class EmployeeRole : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid RoleId { get; set; }
    public bool IsPrimary { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}
