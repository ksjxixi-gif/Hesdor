using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Authorization;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.Audit;
using Hesdor.Domain.Authorization;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/roles")]
[RequirePermission("roles.manage")]
public sealed class RolesController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public RolesController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyCollection<RoleResponse>>> GetRoles(CancellationToken cancellationToken)
    {
        var roles = await _dbContext.Roles.AsNoTracking().OrderBy(role => role.SortOrder).ThenBy(role => role.Name).ToArrayAsync(cancellationToken);
        var roleIds = roles.Select(role => role.Id).ToArray();
        var permissions = await (
            from rolePermission in _dbContext.RolePermissions.AsNoTracking()
            join permission in _dbContext.Permissions on rolePermission.PermissionId equals permission.Id
            where roleIds.Contains(rolePermission.RoleId)
            select new { rolePermission.RoleId, permission.Code, rolePermission.IsAllowed })
            .ToArrayAsync(cancellationToken);

        return Ok(roles.Select(role => new RoleResponse(
            role.Id,
            role.Name,
            role.Description,
            role.IsSystemRole,
            permissions.Where(permission => permission.RoleId == role.Id).Select(permission => new RolePermissionResponse(permission.Code, permission.IsAllowed)).ToArray())).ToArray());
    }

    [HttpGet("permissions")]
    public async Task<ActionResult<IReadOnlyCollection<PermissionResponse>>> GetPermissions(CancellationToken cancellationToken)
    {
        var permissions = await _dbContext.Permissions.AsNoTracking().OrderBy(permission => permission.Module).ThenBy(permission => permission.Code).ToArrayAsync(cancellationToken);
        return Ok(permissions.Select(permission => new PermissionResponse(permission.Id, permission.Code, permission.Name, permission.Module, permission.Description)).ToArray());
    }

    [HttpPost]
    public async Task<ActionResult<RoleResponse>> CreateRole(CreateRoleRequest request, CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant)
        {
            return Unauthorized();
        }

        var name = request.Name.Trim();
        if (await _dbContext.Roles.AnyAsync(role => role.Name == name, cancellationToken))
        {
            return Conflict(new ProblemDetails { Title = "Role name already exists.", Status = StatusCodes.Status409Conflict });
        }

        var codes = request.Permissions.Select(permission => permission.Code.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var permissions = await _dbContext.Permissions.Where(permission => codes.Contains(permission.Code)).ToArrayAsync(cancellationToken);
        if (permissions.Length != codes.Length)
        {
            return BadRequest(new ProblemDetails { Title = "One or more permissions are unknown.", Status = StatusCodes.Status400BadRequest });
        }

        var role = new Role { TenantId = _tenantContext.TenantId, Name = name, Description = request.Description?.Trim(), IsSystemRole = false };
        _dbContext.Roles.Add(role);
        _dbContext.RolePermissions.AddRange(request.Permissions.Select(requestPermission => new RolePermission
        {
            TenantId = _tenantContext.TenantId,
            RoleId = role.Id,
            PermissionId = permissions.Single(permission => string.Equals(permission.Code, requestPermission.Code.Trim(), StringComparison.OrdinalIgnoreCase)).Id,
            IsAllowed = requestPermission.IsAllowed
        }));
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "role.created", nameof(Role), role.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);

        return Created($"/api/roles/{role.Id}", new RoleResponse(role.Id, role.Name, role.Description, role.IsSystemRole, request.Permissions.Select(permission => new RolePermissionResponse(permission.Code, permission.IsAllowed)).ToArray()));
    }
}
