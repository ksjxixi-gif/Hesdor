using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Common;
using Hesdor.Api.Models.People;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Domain.Audit;
using Hesdor.Domain.Identity;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/employees")]
public sealed class EmployeesController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public EmployeesController(
        ApplicationDbContext dbContext,
        ITenantContext tenantContext,
        IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet]
    [RequirePermission("employees.read")]
    public async Task<ActionResult<PagedResponse<EmployeeListItemResponse>>> Get(
        [FromQuery] string? search,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 25,
        CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);
        var query = _dbContext.Employees.AsNoTracking();

        if (!string.IsNullOrWhiteSpace(search))
        {
            var normalizedSearch = search.Trim().ToUpperInvariant();
            query = query.Where(employee =>
                employee.FirstName.ToUpper().Contains(normalizedSearch) ||
                employee.LastName.ToUpper().Contains(normalizedSearch) ||
                employee.EmployeeNumber.ToUpper().Contains(normalizedSearch) ||
                employee.Email != null && employee.Email.ToUpper().Contains(normalizedSearch));
        }

        var totalCount = await query.CountAsync(cancellationToken);
        var employees = await query
            .OrderBy(employee => employee.LastName)
            .ThenBy(employee => employee.FirstName)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToArrayAsync(cancellationToken);

        return Ok(new PagedResponse<EmployeeListItemResponse>(employees.Select(ToResponse).ToArray(), page, pageSize, totalCount));
    }

    [HttpGet("{id:guid}")]
    [RequirePermission("employees.read")]
    public async Task<ActionResult<EmployeeListItemResponse>> GetById(Guid id, CancellationToken cancellationToken)
    {
        var employee = await _dbContext.Employees.AsNoTracking().SingleOrDefaultAsync(entity => entity.Id == id, cancellationToken);
        return employee is null ? NotFound() : Ok(ToResponse(employee));
    }

    [HttpPost]
    [RequirePermission("employees.manage")]
    public async Task<ActionResult<EmployeeListItemResponse>> Create(
        CreateEmployeeRequest request,
        CancellationToken cancellationToken)
    {
        if (!_tenantContext.HasTenant)
        {
            return Unauthorized();
        }

        var employeeNumber = request.EmployeeNumber.Trim();
        if (await _dbContext.Employees.AnyAsync(employee => employee.EmployeeNumber == employeeNumber, cancellationToken))
        {
            return Conflict(new ProblemDetails { Title = "Employee number already exists.", Status = StatusCodes.Status409Conflict });
        }

        if (request.DepartmentId is Guid departmentId && !await _dbContext.Departments.AnyAsync(department => department.Id == departmentId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Department is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        if (request.PrimaryRoleId is Guid roleId && !await _dbContext.Roles.AnyAsync(role => role.Id == roleId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Role is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        if (request.ManagerId is Guid managerId && !await _dbContext.Employees.AnyAsync(employee => employee.Id == managerId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Manager is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var employee = new Employee
        {
            TenantId = _tenantContext.TenantId,
            FirstName = request.FirstName.Trim(),
            MiddleName = request.MiddleName?.Trim(),
            LastName = request.LastName.Trim(),
            Email = request.Email?.Trim(),
            EmployeeNumber = employeeNumber,
            JobTitle = request.JobTitle.Trim(),
            DepartmentId = request.DepartmentId,
            PrimaryRoleId = request.PrimaryRoleId,
            ManagerId = request.ManagerId,
            EmploymentType = request.EmploymentType,
            EmploymentStatus = EmploymentStatus.Active,
            HiredAtUtc = request.HiredAtUtc ?? DateTime.UtcNow
        };

        _dbContext.Employees.Add(employee);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "employee.created", nameof(Employee), employee.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return CreatedAtAction(nameof(GetById), new { id = employee.Id }, ToResponse(employee));
    }

    [HttpPost("{id:guid}/terminate")]
    [RequirePermission("employees.manage")]
    public async Task<IActionResult> Terminate(Guid id, CancellationToken cancellationToken)
    {
        var employee = await _dbContext.Employees.SingleOrDefaultAsync(entity => entity.Id == id, cancellationToken);
        if (employee is null)
        {
            return NotFound();
        }

        var now = DateTime.UtcNow;
        employee.EmploymentStatus = EmploymentStatus.Terminated;
        employee.TerminatedAtUtc = now;
        if (employee.UserId is Guid userId)
        {
            var user = await _dbContext.Users.SingleOrDefaultAsync(entity => entity.Id == userId, cancellationToken);
            if (user is not null)
            {
                user.Status = UserStatus.Suspended;
                var activeTokens = await _dbContext.RefreshTokens.Where(token => token.UserId == userId && token.RevokedAtUtc == null).ToListAsync(cancellationToken);
                foreach (var token in activeTokens)
                {
                    token.RevokedAtUtc = now;
                    token.RevokedByIp = HttpContext.Connection.RemoteIpAddress?.ToString();
                }
            }
        }

        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "employee.terminated", nameof(Employee), employee.Id.ToString(), Severity: AuditSeverity.Critical), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return NoContent();
    }

    private static EmployeeListItemResponse ToResponse(Employee employee) => new(
        employee.Id,
        employee.EmployeeNumber,
        employee.FirstName,
        employee.MiddleName,
        employee.LastName,
        employee.Email,
        employee.JobTitle,
        employee.DepartmentId,
        employee.PrimaryRoleId,
        employee.ManagerId,
        employee.EmploymentStatus,
        employee.EmploymentType,
        employee.HiredAtUtc);
}
