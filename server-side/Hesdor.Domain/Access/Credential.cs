namespace Hesdor.Domain.Access;

public sealed class Credential : MultiTenantEntity
{
    public Guid? EmployeeId { get; set; }
    public CredentialType Type { get; set; }
    public string PublicIdentifier { get; set; } = default!;
    public string? SecureKeyReference { get; set; }
    public CredentialStatus Status { get; set; } = CredentialStatus.Active;
    public DateTime IssuedAtUtc { get; set; }
    public DateTime? ExpiresAtUtc { get; set; }
    public DateTime? RevokedAtUtc { get; set; }
    public string? RevocationReason { get; set; }
}

public enum CredentialType
{
    NfcCard = 0,
    NfcBand = 1,
    KeyTag = 2,
    Mobile = 3,
    VisitorQr = 4
}

public enum CredentialStatus
{
    Active = 0,
    Suspended = 1,
    Revoked = 2,
    Expired = 3
}
