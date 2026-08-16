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
[Route("api/access/credentials")]
public sealed class CredentialsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public CredentialsController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet]
    [RequirePermission("access.policy.manage")]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var credentials = await _dbContext.Credentials.AsNoTracking().OrderByDescending(credential => credential.IssuedAtUtc).Select(credential => new
        {
            credential.Id,
            credential.EmployeeId,
            credential.Type,
            credential.PublicIdentifier,
            credential.Status,
            credential.IssuedAtUtc,
            credential.ExpiresAtUtc,
            credential.RevokedAtUtc
        }).ToArrayAsync(cancellationToken);
        return Ok(credentials);
    }

    [HttpPost]
    [RequirePermission("access.credential.issue")]
    public async Task<IActionResult> Create(CreateCredentialRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Employees.AnyAsync(employee => employee.Id == request.EmployeeId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Employee is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        if (await _dbContext.Credentials.AnyAsync(credential => credential.PublicIdentifier == request.PublicIdentifier.Trim(), cancellationToken))
        {
            return Conflict(new ProblemDetails { Title = "Credential identifier already exists.", Status = StatusCodes.Status409Conflict });
        }

        var credential = new Credential
        {
            TenantId = _tenantContext.TenantId,
            EmployeeId = request.EmployeeId,
            Type = request.Type,
            PublicIdentifier = request.PublicIdentifier.Trim(),
            SecureKeyReference = request.SecureKeyReference?.Trim(),
            IssuedAtUtc = DateTime.UtcNow,
            ExpiresAtUtc = request.ExpiresAtUtc
        };
        _dbContext.Credentials.Add(credential);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "credential.issued", nameof(Credential), credential.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/credentials/{credential.Id}", new { credential.Id, credential.EmployeeId, credential.Type, credential.Status, credential.IssuedAtUtc, credential.ExpiresAtUtc });
    }

    [HttpPost("{id:guid}/revoke")]
    [RequirePermission("access.credential.revoke")]
    public async Task<IActionResult> Revoke(Guid id, RevokeCredentialRequest request, CancellationToken cancellationToken)
    {
        var credential = await _dbContext.Credentials.SingleOrDefaultAsync(entity => entity.Id == id, cancellationToken);
        if (credential is null)
        {
            return NotFound();
        }

        credential.Status = CredentialStatus.Revoked;
        credential.RevokedAtUtc = DateTime.UtcNow;
        credential.RevocationReason = request.Reason.Trim();
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "credential.revoked", nameof(Credential), credential.Id.ToString(), Severity: Hesdor.Domain.Audit.AuditSeverity.Warning), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return NoContent();
    }
}
