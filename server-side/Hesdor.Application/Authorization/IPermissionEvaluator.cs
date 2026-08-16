namespace Hesdor.Application.Authorization;

public interface IPermissionEvaluator
{
    Task<bool> HasPermissionAsync(string permission, CancellationToken cancellationToken = default);

    Task<IReadOnlyCollection<string>> GetPermissionsAsync(CancellationToken cancellationToken = default);
}
