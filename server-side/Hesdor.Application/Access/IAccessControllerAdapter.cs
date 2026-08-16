using Hesdor.Domain.Access;

namespace Hesdor.Application.Access;

public sealed record AccessDeviceHealth(
    string ExternalId,
    bool IsOnline,
    DateTime? LastHeartbeatAtUtc,
    string? FirmwareVersion = null);

public interface IAccessControllerAdapter
{
    string AdapterKey { get; }

    Task PushCredentialsAsync(
        AccessController controller,
        IReadOnlyCollection<Credential> credentials,
        CancellationToken cancellationToken = default);

    Task PushAccessRulesAsync(
        AccessController controller,
        IReadOnlyCollection<AccessRule> rules,
        CancellationToken cancellationToken = default);

    Task UnlockDoorAsync(
        AccessController controller,
        Door door,
        CancellationToken cancellationToken = default);

    Task<AccessDeviceHealth> GetHealthAsync(
        AccessController controller,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyCollection<AccessEvent>> PullEventsAsync(
        AccessController controller,
        DateTime? sinceUtc = null,
        CancellationToken cancellationToken = default);
}
