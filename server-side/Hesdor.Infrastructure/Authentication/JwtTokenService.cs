using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Hesdor.Application.Common;
using Hesdor.Application.Identity;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Hesdor.Infrastructure.Authentication;

public sealed class JwtTokenService : ITokenService
{
    private readonly IConfiguration _configuration;
    private readonly IDateTimeProvider _dateTimeProvider;

    public JwtTokenService(IConfiguration configuration, IDateTimeProvider dateTimeProvider)
    {
        _configuration = configuration;
        _dateTimeProvider = dateTimeProvider;
    }

    public TokenResult IssueAccessToken(IssuedPrincipal principal)
    {
        var signingKey = _configuration["Jwt:SigningKey"];
        if (string.IsNullOrWhiteSpace(signingKey) || signingKey.Length < 32)
        {
            throw new InvalidOperationException("Jwt:SigningKey must contain at least 32 characters.");
        }

        var issuer = _configuration["Jwt:Issuer"] ?? "hesdor-api";
        var audience = _configuration["Jwt:Audience"] ?? "hesdor-web";
        var lifetimeMinutes = _configuration.GetValue("Jwt:AccessTokenMinutes", 60);
        var refreshLifetimeDays = _configuration.GetValue("Jwt:RefreshTokenDays", 30);
        var now = _dateTimeProvider.UtcNow;
        var expiresAtUtc = now.AddMinutes(lifetimeMinutes);
        var refreshTokenExpiresAtUtc = now.AddDays(refreshLifetimeDays);
        var refreshToken = CreateOpaqueToken();

        var claims = new List<Claim>
        {
            new("sub", principal.UserId.ToString()),
            new("tid", principal.TenantId.ToString()),
            new("email", principal.Email)
        };

        claims.AddRange(principal.Roles.Select(role => new Claim(ClaimTypes.Role, role)));

        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            Subject = new ClaimsIdentity(claims),
            NotBefore = now,
            IssuedAt = now,
            Expires = expiresAtUtc,
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
                SecurityAlgorithms.HmacSha256)
        };

        var accessToken = new JsonWebTokenHandler().CreateToken(descriptor);
        return new TokenResult(accessToken, refreshToken, expiresAtUtc, refreshTokenExpiresAtUtc);
    }

    public string HashRefreshToken(string refreshToken)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(refreshToken));
        return Convert.ToHexString(hash);
    }

    private static string CreateOpaqueToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(64);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-", StringComparison.Ordinal)
            .Replace("/", "_", StringComparison.Ordinal)
            .TrimEnd('=');
    }
}
