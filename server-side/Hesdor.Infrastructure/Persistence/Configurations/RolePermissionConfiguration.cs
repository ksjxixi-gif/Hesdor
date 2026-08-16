namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class RolePermissionConfiguration : IEntityTypeConfiguration<RolePermission>
{
    public void Configure(EntityTypeBuilder<RolePermission> builder)
    {
        builder.ToTable("role_permissions");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.RoleId, entity.PermissionId }).IsUnique();
        builder.HasOne<Role>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.RoleId }).HasPrincipalKey(role => new { role.TenantId, role.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Permission>().WithMany().HasForeignKey(entity => entity.PermissionId).OnDelete(DeleteBehavior.Restrict);
    }
}
