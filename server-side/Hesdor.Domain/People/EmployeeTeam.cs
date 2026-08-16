namespace Hesdor.Domain.People;

public sealed class EmployeeTeam : MultiTenantEntity
{
    public Guid EmployeeId { get; set; }
    public Guid TeamId { get; set; }
}
