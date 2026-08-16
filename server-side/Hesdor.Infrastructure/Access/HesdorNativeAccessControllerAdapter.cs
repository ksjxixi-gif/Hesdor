using Hesdor.Application.Access;
using Hesdor.Domain.Access;

namespace Hesdor.Infrastructure.Access;

public sealed class HesdorNativeAccessControllerAdapter : IAccessControllerAdapter
{
    public string AdapterKey => "hesdor-native";

    public Task PushCredentialsAsync(AccessController controller, IReadOnlyCollection<Credential> credentials, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("The Hesdor native controller adapter is a contract placeholder until the edge protocol is implemented.");

    public Task PushAccessRulesAsync(AccessController controller, IReadOnlyCollection<AccessRule> rules, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("The Hesdor native controller adapter is a contract placeholder until the edge protocol is implemented.");

    public Task UnlockDoorAsync(AccessController controller, Door door, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("Remote unlock requires an edge command channel and recent re-authentication.");

    public Task<AccessDeviceHealth> GetHealthAsync(AccessController controller, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("The Hesdor native controller adapter is a contract placeholder until the edge protocol is implemented.");

    public Task<IReadOnlyCollection<AccessEvent>> PullEventsAsync(AccessController controller, DateTime? sinceUtc = null, CancellationToken cancellationToken = default) =>
        throw new NotSupportedException("The Hesdor native controller adapter is a contract placeholder until the edge protocol is implemented.");
}
