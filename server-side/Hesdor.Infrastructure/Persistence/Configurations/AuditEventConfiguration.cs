namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class AuditEventConfiguration : IEntityTypeConfiguration<AuditEvent>
{
    public void Configure(EntityTypeBuilder<AuditEvent> builder)
    {
        builder.ToTable("audit_events");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Action).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.Result).HasMaxLength(80);
        builder.Property(entity => entity.EntityType).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.EntityId).HasMaxLength(160);
        builder.Property(entity => entity.ActorEmail).HasMaxLength(320);
        builder.Property(entity => entity.IpAddress).HasMaxLength(64);
        builder.Property(entity => entity.UserAgent).HasMaxLength(1000);
        builder.Property(entity => entity.PreviousValue).HasColumnType("text");
        builder.Property(entity => entity.NewValue).HasColumnType("text");
        builder.Property(entity => entity.MetadataJson).HasColumnType("text");
        builder.Property(entity => entity.Severity).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.OccurredAtUtc }).IsDescending(false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.ActorUserId, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.EntityType, entity.EntityId, entity.OccurredAtUtc }).IsDescending(false, false, false, true);
    }
}
