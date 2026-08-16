using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Billing;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.Audit;
using Hesdor.Domain.Billing;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

/// <summary>
/// Plan administration for the Hesdor platform team. Plans are global (not per-tenant), so every
/// endpoint requires platform.plans.manage AND a platform-team tenant. Other tenants' owners hold
/// the permission via bootstrap but the IsPlatform gate blocks them.
/// </summary>
[ApiController]
[Authorize]
[Route("api/plans")]
[RequirePermission("platform.plans.manage")]
public sealed class PlansController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public PlansController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyCollection<AdminPlanResponse>>> GetPlans(CancellationToken cancellationToken)
    {
        if (!await IsPlatformAsync(cancellationToken)) return Forbid();

        var plans = await _dbContext.Plans.AsNoTracking().OrderBy(plan => plan.MonthlyPrice).ToArrayAsync(cancellationToken);
        var planIds = plans.Select(plan => plan.Id).ToArray();
        var featuresByPlan = (await _dbContext.PlanFeatures.AsNoTracking().Where(item => planIds.Contains(item.PlanId)).ToArrayAsync(cancellationToken)).ToLookup(item => item.PlanId);
        var limitsByPlan = (await _dbContext.PlanLimits.AsNoTracking().Where(item => planIds.Contains(item.PlanId)).ToArrayAsync(cancellationToken)).ToLookup(item => item.PlanId);

        return Ok(plans.Select(plan => new AdminPlanResponse(
            plan.Id,
            plan.Code,
            plan.Name,
            plan.MonthlyPrice,
            plan.AnnualPrice,
            plan.CurrencyCode,
            plan.IsActive,
            featuresByPlan[plan.Id].Where(item => item.IsEnabled).Select(item => item.Feature.ToString()).ToArray(),
            limitsByPlan[plan.Id].ToDictionary(item => item.Limit.ToString(), item => item.Value))).ToArray());
    }

    [HttpPost]
    public async Task<ActionResult<AdminPlanResponse>> CreatePlan(CreatePlanRequest request, CancellationToken cancellationToken)
    {
        if (!await IsPlatformAsync(cancellationToken)) return Forbid();

        var code = request.Code.Trim().ToLowerInvariant();
        if (await _dbContext.Plans.AnyAsync(plan => plan.Code == code, cancellationToken))
        {
            return Conflict(new ProblemDetails { Title = "Plan code already exists.", Status = StatusCodes.Status409Conflict });
        }

        var now = DateTime.UtcNow;
        var plan = new Plan
        {
            Code = code,
            Name = request.Name.Trim(),
            MonthlyPrice = request.MonthlyPrice,
            AnnualPrice = request.AnnualPrice,
            CurrencyCode = string.IsNullOrWhiteSpace(request.CurrencyCode) ? "USD" : request.CurrencyCode.Trim().ToUpperInvariant(),
            IsActive = request.IsActive,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };
        _dbContext.Plans.Add(plan);
        var invalid = ValidateNames(request.Features, request.Limits.Keys);
        if (invalid is not null)
        {
            return BadRequest(new ProblemDetails { Title = invalid, Status = StatusCodes.Status400BadRequest });
        }
        ApplyDetails(plan, request.Features, request.Limits, now);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "platform.plan.created", nameof(Plan), plan.Id.ToString(), MetadataJson: $"{plan.Code}@{plan.MonthlyPrice} {plan.CurrencyCode}"), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new AdminPlanResponse(plan.Id, plan.Code, plan.Name, plan.MonthlyPrice, plan.AnnualPrice, plan.CurrencyCode, plan.IsActive, request.Features, request.Limits));
    }

    [HttpPut("{planId:guid}")]
    public async Task<IActionResult> UpdatePlan(Guid planId, UpdatePlanRequest request, CancellationToken cancellationToken)
    {
        if (!await IsPlatformAsync(cancellationToken)) return Forbid();

        var plan = await _dbContext.Plans.SingleOrDefaultAsync(item => item.Id == planId, cancellationToken);
        if (plan is null)
        {
            return NotFound(new ProblemDetails { Title = "Plan was not found.", Status = StatusCodes.Status404NotFound });
        }

        if (!string.IsNullOrWhiteSpace(request.Name)) plan.Name = request.Name.Trim();
        if (request.MonthlyPrice is { } monthly) plan.MonthlyPrice = monthly;
        if (request.AnnualPrice is { } annual) plan.AnnualPrice = annual;
        if (!string.IsNullOrWhiteSpace(request.CurrencyCode)) plan.CurrencyCode = request.CurrencyCode.Trim().ToUpperInvariant();
        if (request.IsActive is { } active) plan.IsActive = active;
        plan.UpdatedAtUtc = DateTime.UtcNow;

        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "platform.plan.updated", nameof(Plan), plan.Id.ToString(), MetadataJson: $"{plan.Code}@{plan.MonthlyPrice} {plan.CurrencyCode}, active={plan.IsActive}"), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new AdminPlanResponse(plan.Id, plan.Code, plan.Name, plan.MonthlyPrice, plan.AnnualPrice, plan.CurrencyCode, plan.IsActive, Array.Empty<string>(), new Dictionary<string, long>()));
    }

    [HttpPut("{planId:guid}/details")]
    public async Task<IActionResult> UpdatePlanDetails(Guid planId, UpdatePlanDetailsRequest request, CancellationToken cancellationToken)
    {
        if (!await IsPlatformAsync(cancellationToken)) return Forbid();

        var plan = await _dbContext.Plans.SingleOrDefaultAsync(item => item.Id == planId, cancellationToken);
        if (plan is null)
        {
            return NotFound(new ProblemDetails { Title = "Plan was not found.", Status = StatusCodes.Status404NotFound });
        }

        var now = DateTime.UtcNow;
        if (request.Features is not null || request.Limits is not null)
        {
            var invalid = ValidateNames(request.Features ?? [], request.Limits?.Keys ?? []);
            if (invalid is not null)
            {
                return BadRequest(new ProblemDetails { Title = invalid, Status = StatusCodes.Status400BadRequest });
            }
            _dbContext.PlanFeatures.RemoveRange(_dbContext.PlanFeatures.Where(item => item.PlanId == plan.Id));
            _dbContext.PlanLimits.RemoveRange(_dbContext.PlanLimits.Where(item => item.PlanId == plan.Id));
            ApplyDetails(plan, request.Features ?? [], request.Limits ?? new Dictionary<string, long>(), now);
        }

        plan.UpdatedAtUtc = now;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "platform.plan.details_updated", nameof(Plan), plan.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    // Soft delete: plans with subscriptions can never hard-delete.
    [HttpDelete("{planId:guid}")]
    public async Task<IActionResult> DeactivatePlan(Guid planId, CancellationToken cancellationToken)
    {
        if (!await IsPlatformAsync(cancellationToken)) return Forbid();

        var plan = await _dbContext.Plans.SingleOrDefaultAsync(item => item.Id == planId, cancellationToken);
        if (plan is null)
        {
            return NotFound(new ProblemDetails { Title = "Plan was not found.", Status = StatusCodes.Status404NotFound });
        }

        plan.IsActive = false;
        plan.UpdatedAtUtc = DateTime.UtcNow;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "platform.plan.deactivated", nameof(Plan), plan.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    private async Task<bool> IsPlatformAsync(CancellationToken cancellationToken)
    {
        return _tenantContext.HasTenant
            && await _dbContext.Tenants.IgnoreQueryFilters().AnyAsync(tenant => tenant.Id == _tenantContext.TenantId && tenant.IsPlatform, cancellationToken);
    }

    private static string? ValidateNames(IEnumerable<string> features, IEnumerable<string> limits)
    {
        foreach (var feature in features)
        {
            if (!Enum.TryParse<Feature>(feature, true, out _)) return $"Unknown feature '{feature}'.";
        }
        foreach (var limit in limits)
        {
            if (!Enum.TryParse<LimitType>(limit, true, out _)) return $"Unknown limit '{limit}'.";
        }
        return null;
    }

    private void ApplyDetails(Plan plan, IReadOnlyCollection<string> features, IReadOnlyDictionary<string, long> limits, DateTime now)
    {
        foreach (var featureText in features.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            _dbContext.PlanFeatures.Add(new PlanFeature { PlanId = plan.Id, Feature = Enum.Parse<Feature>(featureText, true), IsEnabled = true, CreatedAtUtc = now, UpdatedAtUtc = now });
        }

        foreach (var (limitText, value) in limits)
        {
            _dbContext.PlanLimits.Add(new PlanLimit { PlanId = plan.Id, Limit = Enum.Parse<LimitType>(limitText, true), Value = value, CreatedAtUtc = now, UpdatedAtUtc = now });
        }
    }
}
