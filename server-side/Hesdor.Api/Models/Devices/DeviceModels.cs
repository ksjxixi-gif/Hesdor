using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Access;

namespace Hesdor.Api.Models.Devices;

public sealed class RegisterControllerRequest
{
    [Required] public Guid LocationId { get; set; }
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(100)] public string AdapterKey { get; set; } = string.Empty;
    [Required, StringLength(200)] public string ExternalId { get; set; } = string.Empty;
    [StringLength(200)] public string? EdgeId { get; set; }
}

public sealed class RegisterReaderRequest
{
    [Required] public Guid AccessControllerId { get; set; }
    [Required] public Guid DoorId { get; set; }
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [Required, StringLength(200)] public string ExternalId { get; set; } = string.Empty;
    public ReaderType Type { get; set; } = ReaderType.Nfc;
}
