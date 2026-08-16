using System.ComponentModel.DataAnnotations;

namespace Hesdor.Api.Models.Authorization;

public sealed class CreateRoleRequest
{
    [Required]
    [StringLength(160)]
    public string Name { get; set; } = string.Empty;

    [StringLength(1000)]
    public string? Description { get; set; }

    public IReadOnlyCollection<RolePermissionRequest> Permissions { get; set; } = Array.Empty<RolePermissionRequest>();
}

public sealed class RolePermissionRequest
{
    [Required]
    public string Code { get; set; } = string.Empty;

    public bool IsAllowed { get; set; } = true;
}

public sealed record RoleResponse(
    Guid Id,
    string Name,
    string? Description,
    bool IsSystemRole,
    IReadOnlyCollection<RolePermissionResponse> Permissions);

public sealed record RolePermissionResponse(string Code, bool IsAllowed);

public sealed record PermissionResponse(
    Guid Id,
    string Code,
    string Name,
    string Module,
    string? Description);
