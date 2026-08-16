namespace Hesdor.Domain.Common;

public abstract class MultiTenantEntity : AuditableEntity
{
    public Guid TenantId { get; set; }
}