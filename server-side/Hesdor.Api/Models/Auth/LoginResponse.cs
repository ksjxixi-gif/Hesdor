namespace Hesdor.Api.Models.Auth;

public sealed record LoginResponse(
    string AccessToken,
    string RefreshToken,
    DateTime ExpiresAtUtc,
    DateTime RefreshTokenExpiresAtUtc);
