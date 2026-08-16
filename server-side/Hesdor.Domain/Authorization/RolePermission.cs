namespace Hesdor.Domain.Authorization;

public sealed class RolePermission : MultiTenantEntity
{
    public Guid RoleId { get; set; }
    public Guid PermissionId { get; set; }
    public bool IsAllowed { get; set; } = true;
}
