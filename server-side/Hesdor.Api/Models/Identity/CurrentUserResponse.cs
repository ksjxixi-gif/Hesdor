namespace Hesdor.Api.Models.Identity;

public sealed record CurrentUserResponse(
    Guid UserId,
    Guid TenantId,
    string? Email,
    IReadOnlyCollection<string> Roles,
    IReadOnlyCollection<string> Permissions,
    bool IsPlatform);
