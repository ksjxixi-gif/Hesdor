using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Billing;
using Hesdor.Application.Billing;
using Hesdor.Application.Common;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/entitlements")]
public sealed class EntitlementsController : ControllerBase
{
    private readonly ITenantContext _tenantContext;
    private readonly IEntitlementService _entitlementService;

    public EntitlementsController(ITenantContext tenantContext, IEntitlementService entitlementService)
    {
        _tenantContext = tenantContext;
        _entitlementService = entitlementService;
    }

    [HttpGet("current")]
    [RequirePermission("billing.read")]
    public async Task<IActionResult> GetCurrent(CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant) return Unauthorized();
        var snapshot = await _entitlementService.GetSnapshotAsync(_tenantContext.TenantId, cancellationToken);
        return snapshot is null ? StatusCode(StatusCodes.Status402PaymentRequired, new ProblemDetails { Title = "No active entitlement state.", Status = StatusCodes.Status402PaymentRequired }) : Ok(new EntitlementResponse(snapshot.TenantId, snapshot.PlanCode, snapshot.SubscriptionStatus, snapshot.CurrentPeriodEndUtc, snapshot.EnabledFeatures, snapshot.Limits));
    }
}
