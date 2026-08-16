using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Devices;
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
[Route("api/devices")]
[RequirePermission("access.device.manage")]
public sealed class DevicesController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public DevicesController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpGet("controllers")]
    public async Task<IActionResult> GetControllers(CancellationToken cancellationToken)
    {
        var controllers = await _dbContext.AccessControllers.AsNoTracking().OrderBy(controller => controller.Name).Select(controller => new
        {
            controller.Id,
            controller.LocationId,
            controller.Name,
            controller.AdapterKey,
            controller.ExternalId,
            controller.Status,
            controller.LastHeartbeatAtUtc,
            controller.EdgeId
        }).ToArrayAsync(cancellationToken);
        return Ok(controllers);
    }

    [HttpPost("controllers")]
    public async Task<IActionResult> RegisterController(RegisterControllerRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Locations.AnyAsync(location => location.Id == request.LocationId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Location is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var controller = new AccessController
        {
            TenantId = _tenantContext.TenantId,
            LocationId = request.LocationId,
            Name = request.Name.Trim(),
            AdapterKey = request.AdapterKey.Trim(),
            ExternalId = request.ExternalId.Trim(),
            EdgeId = request.EdgeId?.Trim(),
            Status = AccessControllerStatus.Pending
        };
        _dbContext.AccessControllers.Add(controller);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "device.controller_registered", nameof(AccessController), controller.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/devices/controllers/{controller.Id}", new { controller.Id, controller.LocationId, controller.AdapterKey, controller.ExternalId, controller.Status });
    }

    [HttpGet("readers")]
    public async Task<IActionResult> GetReaders(CancellationToken cancellationToken)
    {
        var readers = await _dbContext.Readers.AsNoTracking().OrderBy(reader => reader.Name).Select(reader => new
        {
            reader.Id,
            reader.AccessControllerId,
            reader.DoorId,
            reader.Name,
            reader.ExternalId,
            reader.Type
        }).ToArrayAsync(cancellationToken);
        return Ok(readers);
    }

    [HttpPost("readers")]
    public async Task<IActionResult> RegisterReader(RegisterReaderRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.AccessControllers.AnyAsync(controller => controller.Id == request.AccessControllerId, cancellationToken) || !await _dbContext.Doors.AnyAsync(door => door.Id == request.DoorId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Controller and door must belong to this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var reader = new Reader
        {
            TenantId = _tenantContext.TenantId,
            AccessControllerId = request.AccessControllerId,
            DoorId = request.DoorId,
            Name = request.Name.Trim(),
            ExternalId = request.ExternalId.Trim(),
            Type = request.Type
        };
        _dbContext.Readers.Add(reader);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "device.reader_registered", nameof(Reader), reader.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/devices/readers/{reader.Id}", new { reader.Id, reader.AccessControllerId, reader.DoorId, reader.Name, reader.ExternalId, reader.Type });
    }
}
