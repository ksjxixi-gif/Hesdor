using Hesdor.Api.Models.Identity;
using Hesdor.Application.Authorization;
using Hesdor.Application.Common;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/me")]
public sealed class MeController : ControllerBase
{
    private readonly ICurrentUserService _currentUserService;
    private readonly IPermissionEvaluator _permissionEvaluator;
    private readonly ApplicationDbContext _dbContext;

    public MeController(
        ICurrentUserService currentUserService,
        IPermissionEvaluator permissionEvaluator,
        ApplicationDbContext dbContext)
    {
        _currentUserService = currentUserService;
        _permissionEvaluator = permissionEvaluator;
        _dbContext = dbContext;
    }

    [HttpGet]
    public async Task<ActionResult<CurrentUserResponse>> Get(CancellationToken cancellationToken)
    {
        var permissions = await _permissionEvaluator.GetPermissionsAsync(cancellationToken);
        var isPlatform = await _dbContext.Tenants.IgnoreQueryFilters()
            .AnyAsync(tenant => tenant.Id == _currentUserService.TenantId && tenant.IsPlatform, cancellationToken);
        return Ok(new CurrentUserResponse(
            _currentUserService.UserId ?? Guid.Empty,
            _currentUserService.TenantId,
            _currentUserService.Email,
            _currentUserService.Roles,
            permissions,
            isPlatform));
    }
}
