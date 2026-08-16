using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Organization;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/organization")]
public sealed class OrganizationController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public OrganizationController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet("departments")]
    [RequirePermission("organization.read")]
    public async Task<IActionResult> GetDepartments(CancellationToken cancellationToken)
    {
        var departments = await _dbContext.Departments.AsNoTracking().OrderBy(department => department.Name).Select(department => new { department.Id, department.Name, department.Description, department.ParentDepartmentId }).ToArrayAsync(cancellationToken);
        return Ok(departments);
    }

    [HttpPost("departments")]
    [RequirePermission("organization.manage")]
    public async Task<IActionResult> CreateDepartment(CreateDepartmentRequest request, CancellationToken cancellationToken)
    {
        if (request.ParentDepartmentId is Guid parentId && !await _dbContext.Departments.AnyAsync(department => department.Id == parentId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Parent department is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        if (await _dbContext.Departments.AnyAsync(department => department.Name == request.Name.Trim(), cancellationToken)) return Conflict(new ProblemDetails { Title = "Department name already exists.", Status = StatusCodes.Status409Conflict });
        var department = new Department { TenantId = _tenantContext.TenantId, Name = request.Name.Trim(), Description = request.Description?.Trim(), ParentDepartmentId = request.ParentDepartmentId };
        _dbContext.Departments.Add(department);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "department.created", nameof(Department), department.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/organization/departments/{department.Id}", new { department.Id, department.Name, department.Description, department.ParentDepartmentId });
    }

    [HttpPatch("departments/{id:guid}")]
    [RequirePermission("organization.manage")]
    public async Task<IActionResult> UpdateDepartment(Guid id, UpdateDepartmentRequest request, CancellationToken cancellationToken)
    {
        var department = await _dbContext.Departments.SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (department is null) return NotFound();
        if (request.ParentDepartmentId == id) return BadRequest(new ProblemDetails { Title = "A department cannot be its own parent.", Status = StatusCodes.Status400BadRequest });
        if (request.ParentDepartmentId is Guid parentId && !await _dbContext.Departments.AnyAsync(item => item.Id == parentId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Parent department is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        department.Name = request.Name.Trim();
        department.Description = request.Description?.Trim();
        department.ParentDepartmentId = request.ParentDepartmentId;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "department.updated", nameof(Department), department.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new { department.Id, department.Name, department.Description, department.ParentDepartmentId });
    }

    [HttpGet("teams")]
    [RequirePermission("organization.read")]
    public async Task<IActionResult> GetTeams(CancellationToken cancellationToken)
    {
        var teams = await _dbContext.Teams.AsNoTracking().OrderBy(team => team.Name).Select(team => new { team.Id, team.Name, team.Description, team.DepartmentId, team.TeamLeadEmployeeId }).ToArrayAsync(cancellationToken);
        return Ok(teams);
    }

    [HttpPost("teams")]
    [RequirePermission("organization.manage")]
    public async Task<IActionResult> CreateTeam(CreateTeamRequest request, CancellationToken cancellationToken)
    {
        if (request.DepartmentId is Guid departmentId && !await _dbContext.Departments.AnyAsync(department => department.Id == departmentId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Department is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        if (request.TeamLeadEmployeeId is Guid leadId && !await _dbContext.Employees.AnyAsync(employee => employee.Id == leadId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Team lead is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        var team = new Team { TenantId = _tenantContext.TenantId, Name = request.Name.Trim(), Description = request.Description?.Trim(), DepartmentId = request.DepartmentId, TeamLeadEmployeeId = request.TeamLeadEmployeeId };
        _dbContext.Teams.Add(team);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "team.created", nameof(Team), team.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/organization/teams/{team.Id}", new { team.Id, team.Name, team.Description, team.DepartmentId, team.TeamLeadEmployeeId });
    }

    [HttpPatch("teams/{id:guid}")]
    [RequirePermission("organization.manage")]
    public async Task<IActionResult> UpdateTeam(Guid id, UpdateTeamRequest request, CancellationToken cancellationToken)
    {
        var team = await _dbContext.Teams.SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (team is null) return NotFound();
        if (request.DepartmentId is Guid departmentId && !await _dbContext.Departments.AnyAsync(department => department.Id == departmentId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Department is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        if (request.TeamLeadEmployeeId is Guid leadId && !await _dbContext.Employees.AnyAsync(employee => employee.Id == leadId, cancellationToken)) return BadRequest(new ProblemDetails { Title = "Team lead is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        team.Name = request.Name.Trim();
        team.Description = request.Description?.Trim();
        team.DepartmentId = request.DepartmentId;
        team.TeamLeadEmployeeId = request.TeamLeadEmployeeId;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "team.updated", nameof(Team), team.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new { team.Id, team.Name, team.Description, team.DepartmentId, team.TeamLeadEmployeeId });
    }
}
