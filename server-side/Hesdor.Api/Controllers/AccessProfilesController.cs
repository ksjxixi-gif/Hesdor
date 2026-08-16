using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Access;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.Access;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/access/profiles")]
[RequirePermission("access.policy.manage")]
public sealed class AccessProfilesController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public AccessProfilesController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var profiles = await _dbContext.AccessProfiles.AsNoTracking().OrderBy(profile => profile.Name).Select(profile => new { profile.Id, profile.Name, profile.Description, profile.IsSystemProfile }).ToArrayAsync(cancellationToken);
        return Ok(profiles);
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateAccessProfileRequest request, CancellationToken cancellationToken)
    {
        var profile = new AccessProfile { TenantId = _tenantContext.TenantId, Name = request.Name.Trim(), Description = request.Description?.Trim() };
        _dbContext.AccessProfiles.Add(profile);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "access_profile.created", nameof(AccessProfile), profile.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/profiles/{profile.Id}", new { profile.Id, profile.Name, profile.Description });
    }

    [HttpPost("rules")]
    public async Task<IActionResult> CreateRule(CreateAccessRuleRequest request, CancellationToken cancellationToken)
    {
        if (request.ZoneId is null && request.DoorId is null)
        {
            return BadRequest(new ProblemDetails { Title = "An access rule must target a zone or door.", Status = StatusCodes.Status400BadRequest });
        }

        if (!await _dbContext.AccessProfiles.AnyAsync(profile => profile.Id == request.AccessProfileId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Access profile is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        if (request.ZoneId is Guid zoneId && !await _dbContext.Zones.AnyAsync(zone => zone.Id == zoneId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Zone is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        if (request.DoorId is Guid doorId && !await _dbContext.Doors.AnyAsync(door => door.Id == doorId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Door is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var rule = new AccessRule
        {
            TenantId = _tenantContext.TenantId,
            AccessProfileId = request.AccessProfileId,
            ZoneId = request.ZoneId,
            DoorId = request.DoorId,
            DaysOfWeekMask = request.DaysOfWeekMask,
            StartTimeUtc = request.StartTimeUtc,
            EndTimeUtc = request.EndTimeUtc,
            ValidFromUtc = request.ValidFromUtc,
            ValidToUtc = request.ValidToUtc,
            IsAllowed = request.IsAllowed,
            Priority = request.Priority
        };
        _dbContext.AccessRules.Add(rule);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "access_rule.created", nameof(AccessRule), rule.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/profiles/rules/{rule.Id}", new { rule.Id, rule.AccessProfileId, rule.ZoneId, rule.DoorId, rule.IsAllowed });
    }

    [HttpPost("assignments")]
    public async Task<IActionResult> Assign(AssignAccessProfileRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Employees.AnyAsync(employee => employee.Id == request.EmployeeId, cancellationToken) || !await _dbContext.AccessProfiles.AnyAsync(profile => profile.Id == request.AccessProfileId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Employee and access profile must belong to this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var assignment = new EmployeeAccessProfile
        {
            TenantId = _tenantContext.TenantId,
            EmployeeId = request.EmployeeId,
            AccessProfileId = request.AccessProfileId,
            ValidFromUtc = request.ValidFromUtc,
            ValidToUtc = request.ValidToUtc
        };
        _dbContext.EmployeeAccessProfiles.Add(assignment);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "employee_access_profile.assigned", nameof(EmployeeAccessProfile), assignment.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/profiles/assignments/{assignment.Id}", new { assignment.Id, assignment.EmployeeId, assignment.AccessProfileId });
    }
}
