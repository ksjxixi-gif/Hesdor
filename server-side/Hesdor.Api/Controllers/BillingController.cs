using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Billing;
using Hesdor.Application.Billing;
using Hesdor.Application.Common;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Route("api/billing")]
public sealed class BillingController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IEntitlementService _entitlementService;
    private readonly IBillingService _billingService;

    public BillingController(ApplicationDbContext dbContext, ITenantContext tenantContext, IEntitlementService entitlementService, IBillingService billingService)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _entitlementService = entitlementService;
        _billingService = billingService;
    }

    [HttpGet("plans")]
    [AllowAnonymous]
    public async Task<IActionResult> GetPlans(CancellationToken cancellationToken)
    {
        var plans = await _dbContext.Plans.AsNoTracking().Where(plan => plan.IsActive).OrderBy(plan => plan.MonthlyPrice).Select(plan => new PlanResponse(plan.Id, plan.Code, plan.Name, plan.MonthlyPrice, plan.AnnualPrice, plan.CurrencyCode)).ToArrayAsync(cancellationToken);
        return Ok(plans);
    }

    [HttpGet("current")]
    [Authorize]
    [RequirePermission("billing.read")]
    public async Task<IActionResult> GetCurrent(CancellationToken cancellationToken)
    {
        var subscription = _tenantContext.HasTenant ? await _dbContext.Subscriptions.AsNoTracking().OrderByDescending(item => item.CreatedAtUtc).FirstOrDefaultAsync(cancellationToken) : null;
        var snapshot = _tenantContext.HasTenant ? await _entitlementService.GetSnapshotAsync(_tenantContext.TenantId, cancellationToken) : null;
        return Ok(new
        {
            subscription = subscription is null ? null : new SubscriptionResponse(subscription.Id, subscription.PlanId, subscription.Status, subscription.BillingCycle, subscription.Provider, subscription.StartedAtUtc, subscription.CurrentPeriodStartUtc, subscription.CurrentPeriodEndUtc, subscription.TrialEndsAtUtc, subscription.GracePeriodEndsAtUtc, subscription.CancelAtPeriodEnd, subscription.CanceledAtUtc),
            entitlements = snapshot is null ? null : new EntitlementResponse(snapshot.TenantId, snapshot.PlanCode, snapshot.SubscriptionStatus, snapshot.CurrentPeriodEndUtc, snapshot.EnabledFeatures, snapshot.Limits)
        });
    }

    [HttpPost("manual/activate")]
    [Authorize]
    [RequirePermission("billing.manage")]
    public async Task<IActionResult> ActivateManual(ActivateManualSubscriptionRequest request, CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant) return Unauthorized();
        var result = await _billingService.ActivateManualSubscriptionAsync(new ActivateManualSubscriptionCommand(_tenantContext.TenantId, request.PlanCode, request.BillingCycle, request.TrialDays), cancellationToken);
        return result.Succeeded ? Ok(result) : BadRequest(new ProblemDetails { Title = "Subscription activation failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpPost("cancel")]
    [Authorize]
    [RequirePermission("billing.manage")]
    public async Task<IActionResult> Cancel(CancelSubscriptionRequest request, CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant) return Unauthorized();
        var result = await _billingService.CancelSubscriptionAsync(new CancelSubscriptionCommand(_tenantContext.TenantId, request.AtPeriodEnd, request.Reason), cancellationToken);
        return result.Succeeded ? Ok(result) : NotFound(new ProblemDetails { Title = "Subscription was not found.", Detail = result.FailureReason, Status = StatusCodes.Status404NotFound });
    }

    [HttpPost("webhooks/process")]
    [Authorize]
    [RequirePermission("billing.manage")]
    public async Task<IActionResult> ProcessWebhook(BillingWebhookRequest request, CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant || request.TenantId != _tenantContext.TenantId) return Forbid();
        var result = await _billingService.ProcessWebhookAsync(new BillingWebhookCommand(request.TenantId, request.Provider, request.ExternalEventId, request.EventType, request.PayloadJson), cancellationToken);
        return Ok(result);
    }
}
