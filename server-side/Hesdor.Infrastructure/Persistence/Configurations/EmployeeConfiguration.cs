namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class EmployeeConfiguration : IEntityTypeConfiguration<Employee>
{
    public void Configure(EntityTypeBuilder<Employee> builder)
    {
        builder.ToTable("employees");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.FirstName).HasMaxLength(100).IsRequired();
        builder.Property(entity => entity.MiddleName).HasMaxLength(100);
        builder.Property(entity => entity.LastName).HasMaxLength(100).IsRequired();
        builder.Property(entity => entity.Email).HasMaxLength(320);
        builder.Property(entity => entity.EmployeeNumber).HasMaxLength(80).IsRequired();
        builder.Property(entity => entity.JobTitle).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.EmploymentStatus).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.EmploymentType).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeNumber }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.Email });
        builder.HasIndex(entity => new { entity.TenantId, entity.EmploymentStatus });
        builder.HasIndex(entity => new { entity.TenantId, entity.DepartmentId });
        builder.HasIndex(entity => new { entity.TenantId, entity.ManagerId });
    }
}
