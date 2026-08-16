using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Access;

namespace Hesdor.Api.Models.Access;

public sealed class CreateLocationRequest
{
    [Required, StringLength(200)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(80)] public string Code { get; set; } = string.Empty;
    [StringLength(240)] public string? AddressLine1 { get; set; }
    [StringLength(120)] public string? City { get; set; }
    [StringLength(2)] public string? CountryCode { get; set; }
    [StringLength(100)] public string TimeZone { get; set; } = "UTC";
}

public sealed class CreateBuildingRequest
{
    [Required] public Guid LocationId { get; set; }
    [Required, StringLength(200)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(80)] public string Code { get; set; } = string.Empty;
}

public sealed class CreateFloorRequest
{
    [Required] public Guid BuildingId { get; set; }
    [Required, StringLength(120)] public string Name { get; set; } = string.Empty;
    public int Level { get; set; }
}

public sealed class CreateZoneRequest
{
    [Required] public Guid FloorId { get; set; }
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(80)] public string Code { get; set; } = string.Empty;
    public ZoneType Type { get; set; } = ZoneType.General;
}

public sealed class CreateDoorRequest
{
    [Required] public Guid ZoneId { get; set; }
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(80)] public string Code { get; set; } = string.Empty;
    public DoorType Type { get; set; } = DoorType.Internal;
    public bool AffectsAttendance { get; set; }
}

public sealed class CreateCredentialRequest
{
    [Required] public Guid EmployeeId { get; set; }
    public CredentialType Type { get; set; } = CredentialType.NfcCard;
    [Required, StringLength(320)] public string PublicIdentifier { get; set; } = string.Empty;
    [StringLength(320)] public string? SecureKeyReference { get; set; }
    public DateTime? ExpiresAtUtc { get; set; }
}

public sealed class RevokeCredentialRequest
{
    [Required, StringLength(500)] public string Reason { get; set; } = string.Empty;
}

public sealed class CreateAccessProfileRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [StringLength(1000)] public string? Description { get; set; }
}

public sealed class CreateAccessRuleRequest
{
    [Required] public Guid AccessProfileId { get; set; }
    public Guid? ZoneId { get; set; }
    public Guid? DoorId { get; set; }
    [Range(1, 127)] public int DaysOfWeekMask { get; set; } = 127;
    public TimeSpan StartTimeUtc { get; set; }
    public TimeSpan EndTimeUtc { get; set; } = new(23, 59, 59);
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
    public bool IsAllowed { get; set; } = true;
    public int Priority { get; set; }
}

public sealed class AssignAccessProfileRequest
{
    [Required] public Guid EmployeeId { get; set; }
    [Required] public Guid AccessProfileId { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}

public sealed class AccessDecisionRequestDto
{
    [Required] public string CredentialIdentifier { get; set; } = string.Empty;
    [Required] public Guid DoorId { get; set; }
    public DateTime? OccurredAtUtc { get; set; }
    public Guid? ReaderId { get; set; }
    public string? ExternalEventId { get; set; }
    public string? MetadataJson { get; set; }
}

public sealed record AccessDecisionResponse(
    bool IsAllowed,
    AccessDecision Decision,
    string Reason,
    Guid? CredentialId,
    Guid? EmployeeId,
    Guid DoorId,
    DateTime EvaluatedAtUtc);

public sealed record AccessEventResponse(
    Guid Id,
    Guid? CredentialId,
    Guid? EmployeeId,
    Guid DoorId,
    AccessDecision Decision,
    string Reason,
    AccessEventSource Source,
    DateTime OccurredAtUtc);
