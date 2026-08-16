using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Edge;
using Hesdor.Application.Audit;
using Hesdor.Application.Attendance;
using Hesdor.Application.Common;
using Hesdor.Application.Edge;
using Hesdor.Domain.Access;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Route("api/edge")]
public sealed class EdgeController : ControllerBase
{
    private const string ApiKeyHeader = "X-Hesdor-Edge-Key";
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IEdgeCredentialService _credentialService;
    private readonly IAuditWriter _auditWriter;
    private readonly IAttendanceService _attendanceService;

    public EdgeController(ApplicationDbContext dbContext, ITenantContext tenantContext, IEdgeCredentialService credentialService, IAuditWriter auditWriter, IAttendanceService attendanceService)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _credentialService = credentialService;
        _auditWriter = auditWriter;
        _attendanceService = attendanceService;
    }

    [HttpPost("register")]
    [Authorize]
    [RequirePermission("access.device.manage")]
    public async Task<ActionResult<EdgeRegistrationResponse>> Register(RegisterEdgeRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Locations.AnyAsync(location => location.Id == request.LocationId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Location is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var rawApiKey = _credentialService.GenerateCredential();
        var now = DateTime.UtcNow;
        var edgeAgent = new EdgeAgent
        {
            TenantId = _tenantContext.TenantId,
            LocationId = request.LocationId,
            Name = request.Name.Trim(),
            ExternalId = request.ExternalId.Trim(),
            CredentialHash = _credentialService.HashCredential(rawApiKey),
            RegisteredAtUtc = now,
            ConfigVersion = 1
        };
        _dbContext.EdgeAgents.Add(edgeAgent);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "edge.registered", nameof(EdgeAgent), edgeAgent.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new EdgeRegistrationResponse(edgeAgent.Id, edgeAgent.ExternalId, rawApiKey, edgeAgent.RegisteredAtUtc));
    }

    [HttpPost("heartbeat")]
    [AllowAnonymous]
    public async Task<IActionResult> Heartbeat(EdgeHeartbeatRequest request, CancellationToken cancellationToken)
    {
        var edgeAgent = await AuthenticateEdgeAsync(cancellationToken);
        if (edgeAgent is null)
        {
            return Unauthorized();
        }

        edgeAgent.LastHeartbeatAtUtc = DateTime.UtcNow;
        edgeAgent.AgentVersion = request.AgentVersion?.Trim();
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Ok(new { edgeAgent.Id, edgeAgent.Status, edgeAgent.ConfigVersion, edgeAgent.LastHeartbeatAtUtc });
    }

    [HttpPost("sync")]
    [AllowAnonymous]
    public async Task<IActionResult> Sync(CancellationToken cancellationToken)
    {
        var edgeAgent = await AuthenticateEdgeAsync(cancellationToken);
        if (edgeAgent is null)
        {
            return Unauthorized();
        }

        var credentials = await _dbContext.Credentials.IgnoreQueryFilters().Where(credential => credential.TenantId == edgeAgent.TenantId).Select(credential => new
        {
            credential.Id,
            credential.EmployeeId,
            credential.Type,
            credential.PublicIdentifier,
            credential.Status,
            credential.ExpiresAtUtc,
            credential.RevokedAtUtc
        }).ToArrayAsync(cancellationToken);
        var doors = await _dbContext.Doors.IgnoreQueryFilters().Where(door => door.TenantId == edgeAgent.TenantId).Select(door => new { door.Id, door.ZoneId, door.Name, door.Code, door.Type, door.Status }).ToArrayAsync(cancellationToken);
        var rules = await _dbContext.AccessRules.IgnoreQueryFilters().Where(rule => rule.TenantId == edgeAgent.TenantId && !rule.IsDeleted).Select(rule => new
        {
            rule.Id,
            rule.AccessProfileId,
            rule.ZoneId,
            rule.DoorId,
            rule.DaysOfWeekMask,
            rule.StartTimeUtc,
            rule.EndTimeUtc,
            rule.ValidFromUtc,
            rule.ValidToUtc,
            rule.IsAllowed,
            rule.Priority
        }).ToArrayAsync(cancellationToken);

        return Ok(new { edgeAgent.Id, edgeAgent.ConfigVersion, credentials, doors, rules });
    }

    [HttpPost("events")]
    [AllowAnonymous]
    public async Task<IActionResult> UploadEvents(EdgeEventBatchRequest request, CancellationToken cancellationToken)
    {
        var edgeAgent = await AuthenticateEdgeAsync(cancellationToken);
        if (edgeAgent is null)
        {
            return Unauthorized();
        }

        var accepted = new List<string>();
        var duplicates = new List<string>();
        var acceptedEvents = new List<AccessEvent>();
        foreach (var item in request.Events)
        {
            var externalEventId = item.ExternalEventId.Trim();
            if (await _dbContext.AccessEvents.IgnoreQueryFilters().AnyAsync(accessEvent => accessEvent.TenantId == edgeAgent.TenantId && accessEvent.ExternalEventId == externalEventId, cancellationToken))
            {
                duplicates.Add(externalEventId);
                continue;
            }

            var credential = string.IsNullOrWhiteSpace(item.CredentialIdentifier)
                ? null
                : await _dbContext.Credentials.IgnoreQueryFilters().SingleOrDefaultAsync(credential => credential.TenantId == edgeAgent.TenantId && credential.PublicIdentifier == item.CredentialIdentifier, cancellationToken);
            var doorExists = await _dbContext.Doors.IgnoreQueryFilters().AnyAsync(door => door.TenantId == edgeAgent.TenantId && door.Id == item.DoorId, cancellationToken);
            if (!doorExists)
            {
                continue;
            }

            var accessEvent = new AccessEvent
            {
                TenantId = edgeAgent.TenantId,
                CredentialId = credential?.Id,
                EmployeeId = credential?.EmployeeId,
                DoorId = item.DoorId,
                ReaderId = item.ReaderId,
                Decision = item.Decision,
                Reason = item.Reason.Trim(),
                Source = AccessEventSource.Edge,
                ExternalEventId = externalEventId,
                OccurredAtUtc = item.OccurredAtUtc,
                MetadataJson = item.MetadataJson
            };
            _dbContext.AccessEvents.Add(accessEvent);
            acceptedEvents.Add(accessEvent);
            accepted.Add(externalEventId);
        }

        if (accepted.Count > 0)
        {
            foreach (var accessEvent in acceptedEvents)
            {
                await _attendanceService.RecoverPresenceFromAccessEventAsync(edgeAgent.TenantId, accessEvent, cancellationToken);
            }
            await _auditWriter.RecordAsync(new AuditEventInput(edgeAgent.TenantId, "edge.events_uploaded", nameof(AccessEvent), Result: $"accepted:{accepted.Count};duplicates:{duplicates.Count}"), cancellationToken);
            await _dbContext.SaveChangesAsync(cancellationToken);
        }

        return Ok(new { accepted, duplicates });
    }

    [HttpGet("commands")]
    [AllowAnonymous]
    public async Task<IActionResult> Commands(CancellationToken cancellationToken)
    {
        var edgeAgent = await AuthenticateEdgeAsync(cancellationToken);
        if (edgeAgent is null)
        {
            return Unauthorized();
        }

        return Ok(new { edgeAgent.ConfigVersion, commands = Array.Empty<object>() });
    }

    private async Task<EdgeAgent?> AuthenticateEdgeAsync(CancellationToken cancellationToken)
    {
        var rawApiKey = Request.Headers[ApiKeyHeader].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(rawApiKey))
        {
            return null;
        }

        var credentialHash = _credentialService.HashCredential(rawApiKey);
        return await _dbContext.EdgeAgents
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(agent => agent.CredentialHash == credentialHash && agent.Status == EdgeAgentStatus.Active, cancellationToken);
    }
}
