using System.Text.Json.Serialization;

namespace Hesdor.EdgeAgent;

public sealed class SyncResponse
{
    public Guid Id { get; set; }
    public long ConfigVersion { get; set; }
    public List<SyncCredential> Credentials { get; set; } = [];
    public List<SyncDoor> Doors { get; set; } = [];
    public List<SyncRule> Rules { get; set; } = [];
    public List<SyncEmployee> Employees { get; set; } = [];
    public List<SyncEmployeeProfile> EmployeeProfiles { get; set; } = [];
    public List<SyncTemporaryGrant> TemporaryGrants { get; set; } = [];
}

public sealed class SyncCredential
{
    public Guid Id { get; set; }
    public Guid? EmployeeId { get; set; }
    public int Type { get; set; }
    public string PublicIdentifier { get; set; } = string.Empty;
    public int Status { get; set; }
    public DateTime? ExpiresAtUtc { get; set; }
    public DateTime? RevokedAtUtc { get; set; }
}

public sealed class SyncDoor
{
    public Guid Id { get; set; }
    public Guid ZoneId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public int Type { get; set; }
    public int Status { get; set; }
}

public sealed class SyncRule
{
    public Guid Id { get; set; }
    public Guid AccessProfileId { get; set; }
    public Guid? ZoneId { get; set; }
    public Guid? DoorId { get; set; }
    public int DaysOfWeekMask { get; set; }
    public TimeSpan StartTimeUtc { get; set; }
    public TimeSpan EndTimeUtc { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
    public bool IsAllowed { get; set; }
    public int Priority { get; set; }
}

public sealed class SyncEmployee
{
    public Guid Id { get; set; }
    public int EmploymentStatus { get; set; }
}

public sealed class SyncEmployeeProfile
{
    public Guid EmployeeId { get; set; }
    public Guid AccessProfileId { get; set; }
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
}

public sealed class SyncTemporaryGrant
{
    public Guid EmployeeId { get; set; }
    public Guid? ZoneId { get; set; }
    public Guid? DoorId { get; set; }
    public DateTime ValidFromUtc { get; set; }
    public DateTime ValidToUtc { get; set; }
}

public sealed class EdgeEventPayload
{
    public string ExternalEventId { get; set; } = Guid.NewGuid().ToString();
    public Guid DoorId { get; set; }
    public string? CredentialIdentifier { get; set; }
    public Guid? ReaderId { get; set; }
    public int Decision { get; set; }
    public string Reason { get; set; } = string.Empty;
    public DateTime OccurredAtUtc { get; set; }
    public string? MetadataJson { get; set; }
}

public sealed class EventBatchUploadResponse
{
    [JsonPropertyName("accepted")] public List<string> Accepted { get; set; } = [];
    [JsonPropertyName("duplicates")] public List<string> Duplicates { get; set; } = [];
}

// Int values mirror Hesdor.Domain.Access.AccessDecision on the server.
public static class Decision
{
    public const int Granted = 0;
    public const int Denied = 1;
    public const int UnknownCredential = 2;
    public const int ExpiredCredential = 3;
    public const int EmployeeInactive = 4;
    public const int OutsideSchedule = 5;
    public const int TemporaryGrant = 6;
    public const int DeviceOffline = 7;
}

public static class CredentialStatus
{
    public const int Active = 0;
}

public static class EmployeeStatus
{
    public const int Active = 0;
}

public static class DoorStatus
{
    public const int Active = 0;
}
