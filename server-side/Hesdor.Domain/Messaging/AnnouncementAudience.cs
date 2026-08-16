namespace Hesdor.Domain.Messaging;

public sealed class AnnouncementAudience : MultiTenantEntity
{
    public Guid AnnouncementId { get; set; }
    public AnnouncementAudienceType Type { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid? EmployeeId { get; set; }
}

public enum AnnouncementAudienceType
{
    Company = 0,
    Department = 1,
    Team = 2,
    Employee = 3
}
