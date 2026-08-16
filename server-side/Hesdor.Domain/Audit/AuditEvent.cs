namespace Hesdor.Domain.Audit;

public sealed class AuditEvent : MultiTenantEntity
{
    public Guid? ActorUserId { get; set; }
    public string? ActorEmail { get; set; }
    public string Action { get; set; } = default!;
    public string? Result { get; set; }
    public string EntityType { get; set; } = default!;
    public string? EntityId { get; set; }
    public string? PreviousValue { get; set; }
    public string? NewValue { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
    public string? MetadataJson { get; set; }
    public DateTime OccurredAtUtc { get; set; }
    public AuditSeverity Severity { get; set; } = AuditSeverity.Info;
}

public enum AuditSeverity
{
    Info = 0,
    Warning = 1,
    Error = 2,
    Critical = 3
}
