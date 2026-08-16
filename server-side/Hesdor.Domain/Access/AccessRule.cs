namespace Hesdor.Domain.Access;

public sealed class AccessRule : MultiTenantEntity
{
    public Guid AccessProfileId { get; set; }
    public Guid? ZoneId { get; set; }
    public Guid? DoorId { get; set; }
    public int DaysOfWeekMask { get; set; } = 127;
    public TimeSpan StartTimeUtc { get; set; }
    public TimeSpan EndTimeUtc { get; set; } = new(23, 59, 59);
    public DateTime? ValidFromUtc { get; set; }
    public DateTime? ValidToUtc { get; set; }
    public bool IsAllowed { get; set; } = true;
    public int Priority { get; set; }
}
