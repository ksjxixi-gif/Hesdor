using Hesdor.Domain.Audit;

namespace Hesdor.Application.Audit;

public sealed record AuditEventInput(
    Guid TenantId,
    string Action,
    string EntityType,
    string? EntityId = null,
    string? PreviousValue = null,
    string? NewValue = null,
    AuditSeverity Severity = AuditSeverity.Info,
    string? Result = null,
    string? MetadataJson = null);

public interface IAuditWriter
{
    Task RecordAsync(
        AuditEventInput input,
        CancellationToken cancellationToken = default);
}
