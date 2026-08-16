namespace Hesdor.Domain.Identity;

public sealed class User : MultiTenantEntity
{
    public string Email { get; set; } = default!;
    public string NormalizedEmail { get; set; } = default!;
    public string PasswordHash { get; set; } = default!;
    public string DisplayName { get; set; } = default!;
    public UserStatus Status { get; set; } = UserStatus.Active;
    public Guid? EmployeeId { get; set; }
    public int FailedLoginAttempts { get; set; }
    public DateTime? LastLoginAtUtc { get; set; }
    public DateTime? LockedUntilUtc { get; set; }
}

public enum UserStatus { Active = 0, Suspended = 1, Deleted = 2 }