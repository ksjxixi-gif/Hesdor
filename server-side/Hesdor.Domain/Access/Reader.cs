namespace Hesdor.Domain.Access;

public sealed class Reader : MultiTenantEntity
{
    public Guid AccessControllerId { get; set; }
    public Guid DoorId { get; set; }
    public string Name { get; set; } = default!;
    public string ExternalId { get; set; } = default!;
    public ReaderType Type { get; set; } = ReaderType.Nfc;
}

public enum ReaderType
{
    Nfc = 0,
    Wiegand = 1,
    Mobile = 2,
    Qr = 3,
    Biometric = 4
}
