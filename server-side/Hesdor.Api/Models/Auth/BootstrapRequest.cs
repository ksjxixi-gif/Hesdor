using System.ComponentModel.DataAnnotations;

namespace Hesdor.Api.Models.Auth;

public sealed class BootstrapRequest
{
    [Required]
    [StringLength(200, MinimumLength = 2)]
    public string OrganizationName { get; set; } = string.Empty;

    [Required]
    [StringLength(200, MinimumLength = 2)]
    public string DisplayName { get; set; } = string.Empty;

    [Required]
    [EmailAddress]
    public string Email { get; set; } = string.Empty;

    [Required]
    [StringLength(128, MinimumLength = 8)]
    public string Password { get; set; } = string.Empty;

    [StringLength(120)]
    public string? Slug { get; set; }
}
