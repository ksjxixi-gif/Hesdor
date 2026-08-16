using Hesdor.Api.Models.Organizations;
using Hesdor.Application.Common;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/tenants")]
public sealed class TenantsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;

    public TenantsController(
        ApplicationDbContext dbContext,
        ITenantContext tenantContext)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
    }

    [HttpGet("current")]
    public async Task<ActionResult<TenantResponse>> GetCurrent(CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant)
        {
            return Unauthorized();
        }

        var tenant = await _dbContext.Tenants
            .AsNoTracking()
            .SingleOrDefaultAsync(entity => entity.Id == _tenantContext.TenantId, cancellationToken);

        return tenant is null
            ? NotFound()
            : Ok(new TenantResponse(tenant.Id, tenant.Name, tenant.Slug, tenant.Plan, tenant.Status, tenant.TimeZone, tenant.Locale));
    }
}
