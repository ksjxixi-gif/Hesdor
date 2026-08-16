namespace Hesdor.Infrastructure.MultiTenancy;

public sealed class TenantContext : ITenantContext
{
    private readonly ICurrentUserService _currentUserService;

    public TenantContext(ICurrentUserService currentUserService)
    {
        _currentUserService = currentUserService;
    }

    public Guid TenantId => _currentUserService.TenantId;

    public bool HasTenant => TenantId != Guid.Empty;
}
