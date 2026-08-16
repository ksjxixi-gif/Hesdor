using System.ComponentModel.DataAnnotations;

namespace Hesdor.Api.Models.Auth;

public sealed class RefreshRequest
{
    [Required]
    public string RefreshToken { get; set; } = string.Empty;
}
