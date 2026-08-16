using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.People;

namespace Hesdor.Api.Models.People;

public sealed class CreateEmployeeRequest
{
    [Required]
    [StringLength(100)]
    public string FirstName { get; set; } = string.Empty;

    [StringLength(100)]
    public string? MiddleName { get; set; }

    [Required]
    [StringLength(100)]
    public string LastName { get; set; } = string.Empty;

    [EmailAddress]
    public string? Email { get; set; }

    [Required]
    [StringLength(80)]
    public string EmployeeNumber { get; set; } = string.Empty;

    [Required]
    [StringLength(160)]
    public string JobTitle { get; set; } = string.Empty;

    public Guid? DepartmentId { get; set; }
    public Guid? PrimaryRoleId { get; set; }
    public Guid? ManagerId { get; set; }
    public EmploymentType EmploymentType { get; set; } = EmploymentType.FullTime;
    public DateTime? HiredAtUtc { get; set; }
}

public sealed record EmployeeListItemResponse(
    Guid Id,
    string EmployeeNumber,
    string FirstName,
    string? MiddleName,
    string LastName,
    string? Email,
    string JobTitle,
    Guid? DepartmentId,
    Guid? PrimaryRoleId,
    Guid? ManagerId,
    EmploymentStatus EmploymentStatus,
    EmploymentType EmploymentType,
    DateTime? HiredAtUtc);
