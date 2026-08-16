namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class LocationConfiguration : IEntityTypeConfiguration<Location>
{
    public void Configure(EntityTypeBuilder<Location> builder)
    {
        builder.ToTable("locations");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.Code).HasMaxLength(80).IsRequired();
        builder.Property(entity => entity.AddressLine1).HasMaxLength(240);
        builder.Property(entity => entity.AddressLine2).HasMaxLength(240);
        builder.Property(entity => entity.City).HasMaxLength(120);
        builder.Property(entity => entity.CountryCode).HasMaxLength(2);
        builder.Property(entity => entity.TimeZone).HasMaxLength(100).IsRequired();
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.Code }).IsUnique();
    }
}

public sealed class BuildingConfiguration : IEntityTypeConfiguration<Building>
{
    public void Configure(EntityTypeBuilder<Building> builder)
    {
        builder.ToTable("buildings");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.Code).HasMaxLength(80).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.LocationId, entity.Code }).IsUnique();
        builder.HasOne<Location>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.LocationId }).HasPrincipalKey(location => new { location.TenantId, location.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class FloorConfiguration : IEntityTypeConfiguration<Floor>
{
    public void Configure(EntityTypeBuilder<Floor> builder)
    {
        builder.ToTable("floors");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(120).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.BuildingId, entity.Level }).IsUnique();
        builder.HasOne<Building>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.BuildingId }).HasPrincipalKey(building => new { building.TenantId, building.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class ZoneConfiguration : IEntityTypeConfiguration<Zone>
{
    public void Configure(EntityTypeBuilder<Zone> builder)
    {
        builder.ToTable("zones");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.Code).HasMaxLength(80).IsRequired();
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.FloorId, entity.Code }).IsUnique();
        builder.HasOne<Floor>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.FloorId }).HasPrincipalKey(floor => new { floor.TenantId, floor.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class DoorConfiguration : IEntityTypeConfiguration<Door>
{
    public void Configure(EntityTypeBuilder<Door> builder)
    {
        builder.ToTable("doors");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.Code).HasMaxLength(80).IsRequired();
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ZoneId, entity.Code }).IsUnique();
        builder.HasOne<Zone>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ZoneId }).HasPrincipalKey(zone => new { zone.TenantId, zone.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AccessControllerConfiguration : IEntityTypeConfiguration<AccessController>
{
    public void Configure(EntityTypeBuilder<AccessController> builder)
    {
        builder.ToTable("access_controllers");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.AdapterKey).HasMaxLength(100).IsRequired();
        builder.Property(entity => entity.ExternalId).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.EdgeId).HasMaxLength(200);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExternalId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.Status, entity.LastHeartbeatAtUtc });
        builder.HasOne<Location>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.LocationId }).HasPrincipalKey(location => new { location.TenantId, location.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class ReaderConfiguration : IEntityTypeConfiguration<Reader>
{
    public void Configure(EntityTypeBuilder<Reader> builder)
    {
        builder.ToTable("readers");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.ExternalId).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExternalId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.DoorId });
        builder.HasOne<AccessController>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AccessControllerId }).HasPrincipalKey(controller => new { controller.TenantId, controller.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Door>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.DoorId }).HasPrincipalKey(door => new { door.TenantId, door.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class CredentialConfiguration : IEntityTypeConfiguration<Credential>
{
    public void Configure(EntityTypeBuilder<Credential> builder)
    {
        builder.ToTable("credentials");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.PublicIdentifier).HasMaxLength(320).IsRequired();
        builder.Property(entity => entity.SecureKeyReference).HasMaxLength(320);
        builder.Property(entity => entity.RevocationReason).HasMaxLength(500);
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.PublicIdentifier }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.Status });
    }
}

public sealed class AccessProfileConfiguration : IEntityTypeConfiguration<AccessProfile>
{
    public void Configure(EntityTypeBuilder<AccessProfile> builder)
    {
        builder.ToTable("access_profiles");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.Description).HasMaxLength(1000);
        builder.HasIndex(entity => new { entity.TenantId, entity.Name }).IsUnique();
    }
}

public sealed class AccessRuleConfiguration : IEntityTypeConfiguration<AccessRule>
{
    public void Configure(EntityTypeBuilder<AccessRule> builder)
    {
        builder.ToTable("access_rules");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.AccessProfileId, entity.Priority });
        builder.HasIndex(entity => new { entity.TenantId, entity.DoorId, entity.ValidFromUtc, entity.ValidToUtc });
        builder.HasIndex(entity => new { entity.TenantId, entity.ZoneId, entity.ValidFromUtc, entity.ValidToUtc });
        builder.HasOne<AccessProfile>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AccessProfileId }).HasPrincipalKey(profile => new { profile.TenantId, profile.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class EmployeeAccessProfileConfiguration : IEntityTypeConfiguration<EmployeeAccessProfile>
{
    public void Configure(EntityTypeBuilder<EmployeeAccessProfile> builder)
    {
        builder.ToTable("employee_access_profiles");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.AccessProfileId }).IsUnique();
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<AccessProfile>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AccessProfileId }).HasPrincipalKey(profile => new { profile.TenantId, profile.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TemporaryAccessGrantConfiguration : IEntityTypeConfiguration<TemporaryAccessGrant>
{
    public void Configure(EntityTypeBuilder<TemporaryAccessGrant> builder)
    {
        builder.ToTable("temporary_access_grants");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.ValidToUtc });
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AccessEventConfiguration : IEntityTypeConfiguration<AccessEvent>
{
    public void Configure(EntityTypeBuilder<AccessEvent> builder)
    {
        builder.ToTable("access_events");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Decision).HasConversion<string>().HasMaxLength(40);
        builder.Property(entity => entity.Reason).HasMaxLength(300).IsRequired();
        builder.Property(entity => entity.Source).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ExternalEventId).HasMaxLength(200);
        builder.Property(entity => entity.MetadataJson).HasColumnType("text");
        builder.HasIndex(entity => new { entity.TenantId, entity.OccurredAtUtc }).IsDescending(false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.DoorId, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.Decision, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExternalEventId }).IsUnique().HasFilter("\"ExternalEventId\" IS NOT NULL");
        builder.HasOne<Door>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.DoorId }).HasPrincipalKey(door => new { door.TenantId, door.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class EdgeAgentConfiguration : IEntityTypeConfiguration<EdgeAgent>
{
    public void Configure(EntityTypeBuilder<EdgeAgent> builder)
    {
        builder.ToTable("edge_agents");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.ExternalId).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.CredentialHash).HasMaxLength(128).IsRequired();
        builder.Property(entity => entity.AgentVersion).HasMaxLength(80);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExternalId }).IsUnique();
        builder.HasIndex(entity => entity.CredentialHash).IsUnique();
        builder.HasOne<Location>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.LocationId }).HasPrincipalKey(location => new { location.TenantId, location.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
