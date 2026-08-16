using Hesdor.Application.Authorization;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Authorization;

public sealed class PermissionEvaluator : IPermissionEvaluator
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly ITenantContext _tenantContext;
    private readonly IDateTimeProvider _dateTimeProvider;

    public PermissionEvaluator(
        ApplicationDbContext dbContext,
        ICurrentUserService currentUserService,
        ITenantContext tenantContext,
        IDateTimeProvider dateTimeProvider)
    {
        _dbContext = dbContext;
        _currentUserService = currentUserService;
        _tenantContext = tenantContext;
        _dateTimeProvider = dateTimeProvider;
    }

    public async Task<bool> HasPermissionAsync(
        string permission,
        CancellationToken cancellationToken = default)
    {
        var permissions = await GetPermissionsAsync(cancellationToken);
        return permissions.Contains(permission, StringComparer.OrdinalIgnoreCase);
    }

    public async Task<IReadOnlyCollection<string>> GetPermissionsAsync(
        CancellationToken cancellationToken = default)
    {
        if (!_currentUserService.IsAuthenticated ||
            !_tenantContext.HasTenant ||
            _currentUserService.UserId is not Guid userId)
        {
            return Array.Empty<string>();
        }

        var user = await _dbContext.Users
            .IgnoreQueryFilters()
            .AsNoTracking()
            .SingleOrDefaultAsync(
                entity => entity.Id == userId && entity.TenantId == _tenantContext.TenantId,
                cancellationToken);

        if (user is null || user.Status != UserStatus.Active || user.EmployeeId is not Guid employeeId)
        {
            return Array.Empty<string>();
        }

        var now = _dateTimeProvider.UtcNow;
        var directPermissions = await (
            from employeePermission in _dbContext.EmployeePermissions.IgnoreQueryFilters()
            join permission in _dbContext.Permissions
                on employeePermission.PermissionId equals permission.Id
            where employeePermission.TenantId == _tenantContext.TenantId
                && employeePermission.EmployeeId == employeeId
                && !employeePermission.IsDeleted
                && (employeePermission.ValidFromUtc == null || employeePermission.ValidFromUtc <= now)
                && (employeePermission.ValidToUtc == null || employeePermission.ValidToUtc > now)
            select new { permission.Code, employeePermission.IsAllowed })
            .ToListAsync(cancellationToken);

        var rolePermissions = await (
            from employeeRole in _dbContext.EmployeeRoles.IgnoreQueryFilters()
            join rolePermission in _dbContext.RolePermissions.IgnoreQueryFilters()
                on employeeRole.RoleId equals rolePermission.RoleId
            join role in _dbContext.Roles.IgnoreQueryFilters()
                on employeeRole.RoleId equals role.Id
            join permission in _dbContext.Permissions
                on rolePermission.PermissionId equals permission.Id
            where employeeRole.TenantId == _tenantContext.TenantId
                && employeeRole.EmployeeId == employeeId
                && !employeeRole.IsDeleted
                && (employeeRole.ValidFromUtc == null || employeeRole.ValidFromUtc <= now)
                && (employeeRole.ValidToUtc == null || employeeRole.ValidToUtc > now)
                && rolePermission.TenantId == _tenantContext.TenantId
                && !rolePermission.IsDeleted
                && !role.IsDeleted
            select new { permission.Code, rolePermission.IsAllowed })
            .ToListAsync(cancellationToken);

        var effective = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var roleDenies = rolePermissions
            .Where(item => !item.IsAllowed)
            .Select(item => item.Code)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var directDenies = directPermissions
            .Where(item => !item.IsAllowed)
            .Select(item => item.Code)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        foreach (var permissionCode in rolePermissions.Where(item => item.IsAllowed).Select(item => item.Code))
        {
            if (!roleDenies.Contains(permissionCode))
            {
                effective.Add(permissionCode);
            }
        }

        foreach (var permissionCode in directPermissions.Where(item => item.IsAllowed).Select(item => item.Code))
        {
            effective.Add(permissionCode);
        }

        effective.ExceptWith(directDenies);
        return effective.ToArray();
    }
}
