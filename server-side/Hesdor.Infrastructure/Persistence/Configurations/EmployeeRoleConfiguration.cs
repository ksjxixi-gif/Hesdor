namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class EmployeeRoleConfiguration : IEntityTypeConfiguration<EmployeeRole>
{
    public void Configure(EntityTypeBuilder<EmployeeRole> builder)
    {
        builder.ToTable("employee_roles");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.RoleId }).IsUnique();
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Role>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.RoleId }).HasPrincipalKey(role => new { role.TenantId, role.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
