using System.Security.Claims;
using Hesdor.Application.Common;
using Microsoft.AspNetCore.Http;

namespace Hesdor.Infrastructure.Authentication;

public sealed class CurrentUserService : ICurrentUserService
{
    private readonly IHttpContextAccessor _httpContextAccessor;

    public CurrentUserService(IHttpContextAccessor httpContextAccessor)
    {
        _httpContextAccessor = httpContextAccessor;
    }

    private ClaimsPrincipal Principal =>
        _httpContextAccessor.HttpContext?.User ?? new ClaimsPrincipal(new ClaimsIdentity());

    public bool IsAuthenticated => Principal.Identity?.IsAuthenticated == true;

    public Guid? UserId => ParseGuid(
        Principal.FindFirst("sub")?.Value ??
        Principal.FindFirst(ClaimTypes.NameIdentifier)?.Value);

    public Guid TenantId => ParseGuid(Principal.FindFirst("tid")?.Value) ?? Guid.Empty;

    public string? Email =>
        Principal.FindFirst("email")?.Value ??
        Principal.FindFirst(ClaimTypes.Email)?.Value;

    public IReadOnlyCollection<string> Roles => Principal
        .FindAll(ClaimTypes.Role)
        .Select(claim => claim.Value)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

    public bool HasPermission(string permission) => Principal
        .FindAll("permission")
        .Any(claim => string.Equals(claim.Value, permission, StringComparison.OrdinalIgnoreCase));

    private static Guid? ParseGuid(string? value)
    {
        return Guid.TryParse(value, out var result) ? result : null;
    }
}
