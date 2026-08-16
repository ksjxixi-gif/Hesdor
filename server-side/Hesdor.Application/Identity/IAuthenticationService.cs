namespace Hesdor.Application.Identity;

public sealed record AuthenticationRequest(string Email, string Password);

public sealed record BootstrapRequest(
    string OrganizationName,
    string DisplayName,
    string Email,
    string Password,
    string? Slug = null);

public sealed record RefreshTokenRequest(string RefreshToken);

public sealed record AuthenticationResult(
    bool Succeeded,
    TokenResult? Token = null,
    string? FailureReason = null);

public interface IAuthenticationService
{
    Task<AuthenticationResult> BootstrapAsync(
        BootstrapRequest request,
        CancellationToken cancellationToken = default);

    Task<AuthenticationResult> AuthenticateAsync(
        AuthenticationRequest request,
        CancellationToken cancellationToken = default);

    Task<AuthenticationResult> RefreshAsync(
        RefreshTokenRequest request,
        CancellationToken cancellationToken = default);

    Task RevokeRefreshTokenAsync(
        RefreshTokenRequest request,
        CancellationToken cancellationToken = default);
}
