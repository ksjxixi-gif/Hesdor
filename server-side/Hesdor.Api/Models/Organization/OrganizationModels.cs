using System.ComponentModel.DataAnnotations;

namespace Hesdor.Api.Models.Organization;

public sealed class CreateDepartmentRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [StringLength(1000)] public string? Description { get; set; }
    public Guid? ParentDepartmentId { get; set; }
}

public sealed class UpdateDepartmentRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [StringLength(1000)] public string? Description { get; set; }
    public Guid? ParentDepartmentId { get; set; }
}

public sealed class CreateTeamRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [StringLength(1000)] public string? Description { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamLeadEmployeeId { get; set; }
}

public sealed class UpdateTeamRequest
{
    [Required, StringLength(160)] public string Name { get; set; } = string.Empty;
    [StringLength(1000)] public string? Description { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamLeadEmployeeId { get; set; }
}
