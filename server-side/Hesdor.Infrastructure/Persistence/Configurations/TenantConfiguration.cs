namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class TenantConfiguration : IEntityTypeConfiguration<Tenant>
{
    public void Configure(EntityTypeBuilder<Tenant> builder)
    {
        builder.ToTable("tenants");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.Slug).HasMaxLength(120).IsRequired();
        builder.Property(entity => entity.Plan).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.TimeZone).HasMaxLength(100);
        builder.Property(entity => entity.Locale).HasMaxLength(20);
        builder.HasIndex(entity => entity.Slug).IsUnique();
        builder.HasOne<Plan>().WithMany().HasForeignKey(entity => entity.PlanId).OnDelete(DeleteBehavior.Restrict);
    }
}
