namespace Hesdor.Application.Identity;

public sealed record IssuedPrincipal(
    Guid UserId,
    Guid TenantId,
    string Email,
    IReadOnlyCollection<string> Roles);

public sealed record TokenResult(
    string AccessToken,
    string RefreshToken,
    DateTime ExpiresAtUtc,
    DateTime RefreshTokenExpiresAtUtc);

public interface ITokenService
{
    TokenResult IssueAccessToken(IssuedPrincipal principal);

    string HashRefreshToken(string refreshToken);
}
