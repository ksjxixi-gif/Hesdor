using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Billing;
using Hesdor.Application.Billing;
using Hesdor.Application.Common;
using Hesdor.Domain.Billing;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Stripe;

namespace Hesdor.Api.Controllers;

[ApiController]
[Route("api/billing")]
public sealed class BillingController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IEntitlementService _entitlementService;
    private readonly IBillingService _billingService;
    private readonly IConfiguration _configuration;

    public BillingController(ApplicationDbContext dbContext, ITenantContext tenantContext, IEntitlementService entitlementService, IBillingService billingService, IConfiguration configuration)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _entitlementService = entitlementService;
        _billingService = billingService;
        _configuration = configuration;
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

    [HttpPost("webhooks/stripe")]
    [AllowAnonymous]
    public async Task<IActionResult> StripeWebhook(CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(Request.Body);
        var payload = await reader.ReadToEndAsync(cancellationToken);
        var signature = Request.Headers["Stripe-Signature"].FirstOrDefault();
        var secret = _configuration["Stripe:WebhookSecret"];
        if (string.IsNullOrWhiteSpace(secret))
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new ProblemDetails { Title = "Stripe webhooks are not configured.", Status = 503 });
        }

        Event stripeEvent;
        try
        {
            stripeEvent = EventUtility.ConstructEvent(payload, signature, secret);
        }
        catch (StripeException)
        {
            return BadRequest(new ProblemDetails { Title = "Invalid Stripe signature.", Status = 400 });
        }

        // ponytail: tenant binding comes from object metadata (set on Hesdor-created customers).
        // Events without it (e.g. invoice.* where metadata lives on the parent subscription) are acked and ignored.
        if (stripeEvent.Data.Object is IHasMetadata hasMetadata
            && hasMetadata.Metadata.TryGetValue("tenantId", out var tenantIdText)
            && Guid.TryParse(tenantIdText, out var tenantId))
        {
            var existing = await _dbContext.BillingEvents.IgnoreQueryFilters()
                .AnyAsync(item => item.Provider == BillingProvider.Stripe && item.ExternalEventId == stripeEvent.Id, cancellationToken);
            if (!existing)
            {
                _dbContext.BillingEvents.Add(new BillingEvent
                {
                    TenantId = tenantId,
                    Provider = BillingProvider.Stripe,
                    ExternalEventId = stripeEvent.Id,
                    EventType = stripeEvent.Type,
                    PayloadJson = payload,
                    Status = BillingEventStatus.Processed,
                    ReceivedAtUtc = DateTime.UtcNow,
                    ProcessedAtUtc = DateTime.UtcNow
                });
                await _dbContext.SaveChangesAsync(cancellationToken);
            }
        }

        return Ok(new { received = true });
    }
}
