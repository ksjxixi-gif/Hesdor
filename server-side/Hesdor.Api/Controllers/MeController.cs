using Hesdor.Api.Models.Identity;
using Hesdor.Application.Authorization;
using Hesdor.Application.Common;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/me")]
public sealed class MeController : ControllerBase
{
    private readonly ICurrentUserService _currentUserService;
    private readonly IPermissionEvaluator _permissionEvaluator;

    public MeController(
        ICurrentUserService currentUserService,
        IPermissionEvaluator permissionEvaluator)
    {
        _currentUserService = currentUserService;
        _permissionEvaluator = permissionEvaluator;
    }

    [HttpGet]
    public async Task<ActionResult<CurrentUserResponse>> Get(CancellationToken cancellationToken)
    {
        var permissions = await _permissionEvaluator.GetPermissionsAsync(cancellationToken);
        return Ok(new CurrentUserResponse(
            _currentUserService.UserId ?? Guid.Empty,
            _currentUserService.TenantId,
            _currentUserService.Email,
            _currentUserService.Roles,
            permissions));
    }
}
