namespace Hesdor.Domain.People;

public sealed class Employee : MultiTenantEntity
{
    public string FirstName { get; set; } = default!;
    public string? MiddleName { get; set; }
    public string LastName { get; set; } = default!;
    public string? Email { get; set; }
    public string EmployeeNumber { get; set; } = default!;
    public string JobTitle { get; set; } = default!;
    public Guid? UserId { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? PrimaryRoleId { get; set; }
    public Guid? ManagerId { get; set; }
    public EmploymentStatus EmploymentStatus { get; set; } = EmploymentStatus.Active;
    public EmploymentType EmploymentType { get; set; } = EmploymentType.FullTime;
    public DateTime? HiredAtUtc { get; set; }
    public DateTime? TerminatedAtUtc { get; set; }
}

public enum EmploymentStatus { Prospective = 0, Active = 1, OnLeave = 2, Terminated = 3 }
public enum EmploymentType { FullTime = 0, PartTime = 1, Contractor = 2, Intern = 3 }