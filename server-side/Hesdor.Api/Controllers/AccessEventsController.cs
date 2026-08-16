using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Access;
using Hesdor.Application.Access;
using Hesdor.Application.Attendance;
using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Application.Realtime;
using Hesdor.Domain.Access;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/access/events")]
public sealed class AccessEventsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAccessPolicyEvaluator _policyEvaluator;
    private readonly IAuditWriter _auditWriter;
    private readonly IRealtimeEventPublisher _realtimeEventPublisher;
    private readonly IAttendanceService _attendanceService;

    public AccessEventsController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAccessPolicyEvaluator policyEvaluator, IAuditWriter auditWriter, IRealtimeEventPublisher realtimeEventPublisher, IAttendanceService attendanceService)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _policyEvaluator = policyEvaluator;
        _auditWriter = auditWriter;
        _realtimeEventPublisher = realtimeEventPublisher;
        _attendanceService = attendanceService;
    }

    [HttpPost("decide")]
    [RequirePermission("access.policy.manage")]
    public async Task<ActionResult<AccessDecisionResponse>> Decide(AccessDecisionRequestDto request, CancellationToken cancellationToken)
    {
        var occurredAtUtc = request.OccurredAtUtc ?? DateTime.UtcNow;
        if (!string.IsNullOrWhiteSpace(request.ExternalEventId))
        {
            var existing = await _dbContext.AccessEvents.AsNoTracking().SingleOrDefaultAsync(accessEvent => accessEvent.ExternalEventId == request.ExternalEventId, cancellationToken);
            if (existing is not null)
            {
                return Ok(new AccessDecisionResponse(existing.Decision is AccessDecision.Granted or AccessDecision.TemporaryGrant, existing.Decision, existing.Reason, existing.CredentialId, existing.EmployeeId, existing.DoorId, existing.OccurredAtUtc));
            }
        }

        var decision = await _policyEvaluator.EvaluateAsync(new AccessDecisionRequest(request.CredentialIdentifier.Trim(), request.DoorId, occurredAtUtc, request.ReaderId, AccessEventSource.Controller, request.ExternalEventId, request.MetadataJson), cancellationToken);
        var accessEvent = new AccessEvent
        {
            TenantId = _tenantContext.TenantId,
            CredentialId = decision.CredentialId,
            EmployeeId = decision.EmployeeId,
            DoorId = decision.DoorId,
            ReaderId = request.ReaderId,
            Decision = decision.Decision,
            Reason = decision.Reason,
            Source = AccessEventSource.Controller,
            ExternalEventId = request.ExternalEventId,
            OccurredAtUtc = occurredAtUtc,
            MetadataJson = request.MetadataJson
        };
        _dbContext.AccessEvents.Add(accessEvent);
        await _attendanceService.RecoverPresenceFromAccessEventAsync(_tenantContext.TenantId, accessEvent, cancellationToken);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, decision.IsAllowed ? "access.granted" : "access.denied", nameof(AccessEvent), accessEvent.Id.ToString(), Severity: decision.IsAllowed ? Hesdor.Domain.Audit.AuditSeverity.Info : Hesdor.Domain.Audit.AuditSeverity.Warning, Result: decision.Decision.ToString(), MetadataJson: request.MetadataJson), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, decision.IsAllowed ? "access.granted" : "access.denied", new
        {
            accessEvent.Id,
            accessEvent.DoorId,
            accessEvent.EmployeeId,
            accessEvent.Decision,
            accessEvent.Reason,
            accessEvent.OccurredAtUtc
        }, cancellationToken);
        return Ok(new AccessDecisionResponse(decision.IsAllowed, decision.Decision, decision.Reason, decision.CredentialId, decision.EmployeeId, decision.DoorId, decision.EvaluatedAtUtc));
    }

    [HttpGet]
    [RequirePermission("access.policy.manage")]
    public async Task<IActionResult> Get([FromQuery] int page = 1, [FromQuery] int pageSize = 50, CancellationToken cancellationToken = default)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);
        var query = _dbContext.AccessEvents.AsNoTracking().OrderByDescending(accessEvent => accessEvent.OccurredAtUtc);
        var totalCount = await query.CountAsync(cancellationToken);
        var events = await query.Skip((page - 1) * pageSize).Take(pageSize).Select(accessEvent => new AccessEventResponse(accessEvent.Id, accessEvent.CredentialId, accessEvent.EmployeeId, accessEvent.DoorId, accessEvent.Decision, accessEvent.Reason, accessEvent.Source, accessEvent.OccurredAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(new { items = events, page, pageSize, totalCount });
    }
}
