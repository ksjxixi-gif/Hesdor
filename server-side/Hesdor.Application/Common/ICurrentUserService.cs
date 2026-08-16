namespace Hesdor.Application.Common;

public interface ICurrentUserService
{
    bool IsAuthenticated { get; }
    Guid? UserId { get; }
    Guid TenantId { get; }
    string? Email { get; }
    IReadOnlyCollection<string> Roles { get; }
    bool HasPermission(string permission);
}
