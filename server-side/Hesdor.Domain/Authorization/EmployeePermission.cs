namespace Hesdor.Domain.Authorization;

public sealed class EmployeePermission : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid PermissionId { get; set; }
    public bool IsAllowed { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}
