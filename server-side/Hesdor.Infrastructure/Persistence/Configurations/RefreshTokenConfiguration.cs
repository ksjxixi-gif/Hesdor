namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class RefreshTokenConfiguration : IEntityTypeConfiguration<RefreshToken>
{
    public void Configure(EntityTypeBuilder<RefreshToken> builder)
    {
        builder.ToTable("refresh_tokens");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.TokenHash).HasMaxLength(128).IsRequired();
        builder.Property(entity => entity.CreatedByIp).HasMaxLength(64);
        builder.Property(entity => entity.RevokedByIp).HasMaxLength(64);
        builder.Property(entity => entity.ReplacedByTokenHash).HasMaxLength(128);
        builder.HasIndex(entity => entity.TokenHash).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.UserId, entity.ExpiresAtUtc });
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.UserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
