namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class PlanConfiguration : IEntityTypeConfiguration<Plan>
{
    public void Configure(EntityTypeBuilder<Plan> builder)
    {
        builder.ToTable("plans");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Code).HasMaxLength(80).IsRequired();
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.MonthlyPrice).HasPrecision(18, 2);
        builder.Property(entity => entity.AnnualPrice).HasPrecision(18, 2);
        builder.Property(entity => entity.CurrencyCode).HasMaxLength(3).IsRequired();
        builder.HasIndex(entity => entity.Code).IsUnique();
    }
}

public sealed class PlanFeatureConfiguration : IEntityTypeConfiguration<PlanFeature>
{
    public void Configure(EntityTypeBuilder<PlanFeature> builder)
    {
        builder.ToTable("plan_features");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Feature).HasConversion<string>().HasMaxLength(64);
        builder.HasIndex(entity => new { entity.PlanId, entity.Feature }).IsUnique();
        builder.HasOne<Plan>().WithMany().HasForeignKey(entity => entity.PlanId).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PlanLimitConfiguration : IEntityTypeConfiguration<PlanLimit>
{
    public void Configure(EntityTypeBuilder<PlanLimit> builder)
    {
        builder.ToTable("plan_limits");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Limit).HasConversion<string>().HasMaxLength(64);
        builder.HasIndex(entity => new { entity.PlanId, entity.Limit }).IsUnique();
        builder.HasOne<Plan>().WithMany().HasForeignKey(entity => entity.PlanId).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TenantEntitlementConfiguration : IEntityTypeConfiguration<TenantEntitlement>
{
    public void Configure(EntityTypeBuilder<TenantEntitlement> builder)
    {
        builder.ToTable("tenant_entitlements");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Feature).HasConversion<string>().HasMaxLength(64);
        builder.Property(entity => entity.Source).HasMaxLength(120).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Feature, entity.ValidFromUtc, entity.ValidToUtc });
    }
}

public sealed class FeatureOverrideConfiguration : IEntityTypeConfiguration<FeatureOverride>
{
    public void Configure(EntityTypeBuilder<FeatureOverride> builder)
    {
        builder.ToTable("feature_overrides");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Feature).HasConversion<string>().HasMaxLength(64);
        builder.Property(entity => entity.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Feature, entity.ValidFromUtc, entity.ValidToUtc });
    }
}

public sealed class TenantLimitOverrideConfiguration : IEntityTypeConfiguration<TenantLimitOverride>
{
    public void Configure(EntityTypeBuilder<TenantLimitOverride> builder)
    {
        builder.ToTable("tenant_limit_overrides");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Limit).HasConversion<string>().HasMaxLength(64);
        builder.Property(entity => entity.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Limit, entity.ValidFromUtc, entity.ValidToUtc });
    }
}

public sealed class SubscriptionConfiguration : IEntityTypeConfiguration<Subscription>
{
    public void Configure(EntityTypeBuilder<Subscription> builder)
    {
        builder.ToTable("subscriptions");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.BillingCycle).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.CancellationReason).HasMaxLength(500);
        builder.HasIndex(entity => new { entity.TenantId, entity.Status, entity.CurrentPeriodEndUtc });
        builder.HasIndex(entity => new { entity.TenantId, entity.CurrentPeriodEndUtc });
        builder.HasOne<Plan>().WithMany().HasForeignKey(entity => entity.PlanId).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TenantTrialConfiguration : IEntityTypeConfiguration<TenantTrial>
{
    public void Configure(EntityTypeBuilder<TenantTrial> builder)
    {
        builder.ToTable("tenant_trials");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.EndsAtUtc });
    }
}

public sealed class BillingCustomerConfiguration : IEntityTypeConfiguration<BillingCustomer>
{
    public void Configure(EntityTypeBuilder<BillingCustomer> builder)
    {
        builder.ToTable("billing_customers");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ExternalReference).HasMaxLength(320).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Provider }).IsUnique();
    }
}

public sealed class PaymentProviderReferenceConfiguration : IEntityTypeConfiguration<PaymentProviderReference>
{
    public void Configure(EntityTypeBuilder<PaymentProviderReference> builder)
    {
        builder.ToTable("payment_provider_references");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ReferenceType).HasMaxLength(100).IsRequired();
        builder.Property(entity => entity.ExternalReference).HasMaxLength(320).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Provider, entity.ReferenceType, entity.ExternalReference }).IsUnique();
    }
}

public sealed class InvoiceReferenceConfiguration : IEntityTypeConfiguration<InvoiceReference>
{
    public void Configure(EntityTypeBuilder<InvoiceReference> builder)
    {
        builder.ToTable("invoice_references");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ExternalReference).HasMaxLength(320).IsRequired();
        builder.Property(entity => entity.Status).HasMaxLength(64).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Provider, entity.ExternalReference }).IsUnique();
    }
}

public sealed class BillingEventConfiguration : IEntityTypeConfiguration<BillingEvent>
{
    public void Configure(EntityTypeBuilder<BillingEvent> builder)
    {
        builder.ToTable("billing_events");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ExternalEventId).HasMaxLength(320).IsRequired();
        builder.Property(entity => entity.EventType).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.PayloadJson).HasColumnType("jsonb").IsRequired();
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.FailureReason).HasMaxLength(1000);
        builder.HasIndex(entity => new { entity.TenantId, entity.Provider, entity.ExternalEventId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.ReceivedAtUtc });
    }
}
