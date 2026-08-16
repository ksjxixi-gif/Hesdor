namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class EmployeeTeamConfiguration : IEntityTypeConfiguration<EmployeeTeam>
{
    public void Configure(EntityTypeBuilder<EmployeeTeam> builder)
    {
        builder.ToTable("employee_teams");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.TeamId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.TeamId });
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Team>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.TeamId }).HasPrincipalKey(team => new { team.TenantId, team.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
