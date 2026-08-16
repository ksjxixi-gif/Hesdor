namespace Hesdor.Domain.Organizations;

public sealed class Tenant : AuditableEntity
{
    public string Name { get; set; } = default!;
    public string Slug { get; set; } = default!;
    public TenantPlan Plan { get; set; } = TenantPlan.Free;
    public Guid? PlanId { get; set; }
    public TenantStatus Status { get; set; } = TenantStatus.Trial;
    public string? TimeZone { get; set; }
    public string? Locale { get; set; }
    public DateTime? TrialEndsAtUtc { get; set; }
    public Guid? OwnerUserId { get; set; }
    public bool IsPlatform { get; set; }
}

public enum TenantPlan { Free = 0, Starter = 1, Business = 2, Enterprise = 3 }
public enum TenantStatus { Trial = 0, Active = 1, PastDue = 2, Suspended = 3, Terminated = 4 }
