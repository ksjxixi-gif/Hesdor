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
[Route("api/access")]
[RequirePermission("access.policy.manage")]
public sealed class AccessStructureController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IAuditWriter _auditWriter;

    public AccessStructureController(ApplicationDbContext dbContext, ITenantContext tenantContext, IAuditWriter auditWriter)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _auditWriter = auditWriter;
    }

    [HttpPost("locations")]
    public async Task<IActionResult> CreateLocation(CreateLocationRequest request, CancellationToken cancellationToken)
    {
        var location = new Location
        {
            TenantId = _tenantContext.TenantId,
            Name = request.Name.Trim(),
            Code = request.Code.Trim(),
            AddressLine1 = request.AddressLine1?.Trim(),
            City = request.City?.Trim(),
            CountryCode = request.CountryCode?.Trim().ToUpperInvariant(),
            TimeZone = request.TimeZone.Trim()
        };
        _dbContext.Locations.Add(location);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "location.created", nameof(Location), location.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/locations/{location.Id}", new { location.Id, location.Name, location.Code, location.TimeZone });
    }

    [HttpPost("buildings")]
    public async Task<IActionResult> CreateBuilding(CreateBuildingRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Locations.AnyAsync(location => location.Id == request.LocationId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Location is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var building = new Building { TenantId = _tenantContext.TenantId, LocationId = request.LocationId, Name = request.Name.Trim(), Code = request.Code.Trim() };
        _dbContext.Buildings.Add(building);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "building.created", nameof(Building), building.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/buildings/{building.Id}", new { building.Id, building.LocationId, building.Name, building.Code });
    }

    [HttpPost("floors")]
    public async Task<IActionResult> CreateFloor(CreateFloorRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Buildings.AnyAsync(building => building.Id == request.BuildingId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Building is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var floor = new Floor { TenantId = _tenantContext.TenantId, BuildingId = request.BuildingId, Name = request.Name.Trim(), Level = request.Level };
        _dbContext.Floors.Add(floor);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "floor.created", nameof(Floor), floor.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/floors/{floor.Id}", new { floor.Id, floor.BuildingId, floor.Name, floor.Level });
    }

    [HttpPost("zones")]
    public async Task<IActionResult> CreateZone(CreateZoneRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Floors.AnyAsync(floor => floor.Id == request.FloorId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Floor is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var zone = new Zone { TenantId = _tenantContext.TenantId, FloorId = request.FloorId, Name = request.Name.Trim(), Code = request.Code.Trim(), Type = request.Type };
        _dbContext.Zones.Add(zone);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "zone.created", nameof(Zone), zone.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/zones/{zone.Id}", new { zone.Id, zone.FloorId, zone.Name, zone.Code, zone.Type });
    }

    [HttpPost("doors")]
    public async Task<IActionResult> CreateDoor(CreateDoorRequest request, CancellationToken cancellationToken)
    {
        if (!await _dbContext.Zones.AnyAsync(zone => zone.Id == request.ZoneId, cancellationToken))
        {
            return BadRequest(new ProblemDetails { Title = "Zone is not part of this organization.", Status = StatusCodes.Status400BadRequest });
        }

        var door = new Door { TenantId = _tenantContext.TenantId, ZoneId = request.ZoneId, Name = request.Name.Trim(), Code = request.Code.Trim(), Type = request.Type, AffectsAttendance = request.AffectsAttendance };
        _dbContext.Doors.Add(door);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "door.created", nameof(Door), door.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return Created($"/api/access/doors/{door.Id}", new { door.Id, door.ZoneId, door.Name, door.Code, door.Type, door.Status, door.AffectsAttendance });
    }

    [HttpGet("doors")]
    public async Task<IActionResult> GetDoors([FromQuery] string? search, CancellationToken cancellationToken)
    {
        var query = _dbContext.Doors.AsNoTracking();
        if (!string.IsNullOrWhiteSpace(search))
        {
            var value = search.Trim().ToUpperInvariant();
            query = query.Where(door => door.Name.ToUpper().Contains(value) || door.Code.ToUpper().Contains(value));
        }

        var doors = await query.OrderBy(door => door.Name).Select(door => new { door.Id, door.ZoneId, door.Name, door.Code, door.Type, door.Status, door.AffectsAttendance }).ToArrayAsync(cancellationToken);
        return Ok(doors);
    }
}
