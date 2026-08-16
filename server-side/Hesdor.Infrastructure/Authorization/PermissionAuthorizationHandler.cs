using Hesdor.Application.Authorization;
using Microsoft.AspNetCore.Authorization;

namespace Hesdor.Infrastructure.Authorization;

public sealed class PermissionAuthorizationHandler : AuthorizationHandler<PermissionRequirement>
{
    private readonly IPermissionEvaluator _permissionEvaluator;

    public PermissionAuthorizationHandler(IPermissionEvaluator permissionEvaluator)
    {
        _permissionEvaluator = permissionEvaluator;
    }

    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        PermissionRequirement requirement)
    {
        if (await _permissionEvaluator.HasPermissionAsync(requirement.Permission))
        {
            context.Succeed(requirement);
        }
    }
}
