namespace Hesdor.Infrastructure.Persistence;

public sealed class ApplicationDbContext : DbContext
{
    private readonly ICurrentUserService _currentUserService;
    private readonly ITenantContext _tenantContext;
    private readonly IDateTimeProvider _dateTimeProvider;

    public ApplicationDbContext(
        DbContextOptions<ApplicationDbContext> options,
        ICurrentUserService currentUserService,
        ITenantContext tenantContext,
        IDateTimeProvider dateTimeProvider)
        : base(options)
    {
        _currentUserService = currentUserService;
        _tenantContext = tenantContext;
        _dateTimeProvider = dateTimeProvider;
    }

    public Guid CurrentTenantId => _tenantContext.TenantId;

    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Employee> Employees => Set<Employee>();
    public DbSet<Department> Departments => Set<Department>();
    public DbSet<Team> Teams => Set<Team>();
    public DbSet<Role> Roles => Set<Role>();
    public DbSet<Permission> Permissions => Set<Permission>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<EmployeeRole> EmployeeRoles => Set<EmployeeRole>();
    public DbSet<EmployeePermission> EmployeePermissions => Set<EmployeePermission>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();
    public DbSet<Location> Locations => Set<Location>();
    public DbSet<Building> Buildings => Set<Building>();
    public DbSet<Floor> Floors => Set<Floor>();
    public DbSet<Zone> Zones => Set<Zone>();
    public DbSet<Door> Doors => Set<Door>();
    public DbSet<AccessController> AccessControllers => Set<AccessController>();
    public DbSet<Reader> Readers => Set<Reader>();
    public DbSet<Credential> Credentials => Set<Credential>();
    public DbSet<AccessProfile> AccessProfiles => Set<AccessProfile>();
    public DbSet<AccessRule> AccessRules => Set<AccessRule>();
    public DbSet<EmployeeAccessProfile> EmployeeAccessProfiles => Set<EmployeeAccessProfile>();
    public DbSet<TemporaryAccessGrant> TemporaryAccessGrants => Set<TemporaryAccessGrant>();
    public DbSet<AccessEvent> AccessEvents => Set<AccessEvent>();
    public DbSet<EdgeAgent> EdgeAgents => Set<EdgeAgent>();
    public DbSet<AttendancePolicy> AttendancePolicies => Set<AttendancePolicy>();
    public DbSet<WorkSchedule> WorkSchedules => Set<WorkSchedule>();
    public DbSet<WorkScheduleDay> WorkScheduleDays => Set<WorkScheduleDay>();
    public DbSet<ScheduleAssignment> ScheduleAssignments => Set<ScheduleAssignment>();
    public DbSet<AttendanceSession> AttendanceSessions => Set<AttendanceSession>();
    public DbSet<AttendanceEvent> AttendanceEvents => Set<AttendanceEvent>();
    public DbSet<AttendanceBreak> AttendanceBreaks => Set<AttendanceBreak>();
    public DbSet<AttendanceAdjustment> AttendanceAdjustments => Set<AttendanceAdjustment>();
    public DbSet<EmployeePresence> EmployeePresence => Set<EmployeePresence>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<WorkTask> Tasks => Set<WorkTask>();
    public DbSet<TaskAssignee> TaskAssignees => Set<TaskAssignee>();
    public DbSet<TaskComment> TaskComments => Set<TaskComment>();
    public DbSet<TaskActivity> TaskActivities => Set<TaskActivity>();
    public DbSet<EmployeeTeam> EmployeeTeams => Set<EmployeeTeam>();
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<ConversationMember> ConversationMembers => Set<ConversationMember>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageMention> MessageMentions => Set<MessageMention>();
    public DbSet<MessageReaction> MessageReactions => Set<MessageReaction>();
    public DbSet<MessageReadState> MessageReadStates => Set<MessageReadState>();
    public DbSet<Announcement> Announcements => Set<Announcement>();
    public DbSet<AnnouncementAudience> AnnouncementAudiences => Set<AnnouncementAudience>();
    public DbSet<Plan> Plans => Set<Plan>();
    public DbSet<PlanFeature> PlanFeatures => Set<PlanFeature>();
    public DbSet<PlanLimit> PlanLimits => Set<PlanLimit>();
    public DbSet<TenantEntitlement> TenantEntitlements => Set<TenantEntitlement>();
    public DbSet<FeatureOverride> FeatureOverrides => Set<FeatureOverride>();
    public DbSet<TenantLimitOverride> TenantLimitOverrides => Set<TenantLimitOverride>();
    public DbSet<Subscription> Subscriptions => Set<Subscription>();
    public DbSet<TenantTrial> TenantTrials => Set<TenantTrial>();
    public DbSet<BillingCustomer> BillingCustomers => Set<BillingCustomer>();
    public DbSet<PaymentProviderReference> PaymentProviderReferences => Set<PaymentProviderReference>();
    public DbSet<InvoiceReference> InvoiceReferences => Set<InvoiceReference>();
    public DbSet<BillingEvent> BillingEvents => Set<BillingEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(ApplicationDbContext).Assembly);

        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            foreach (var property in entityType.GetProperties())
            {
                var propertyType = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                if (propertyType == typeof(DateTime))
                {
                    property.SetColumnType("timestamp with time zone");
                }
            }

            if (typeof(MultiTenantEntity).IsAssignableFrom(entityType.ClrType))
            {
                var tenantOwnedEntity = modelBuilder.Entity(entityType.ClrType);
                tenantOwnedEntity.HasAlternateKey(nameof(MultiTenantEntity.TenantId), nameof(BaseEntity.Id));
                tenantOwnedEntity.HasOne(typeof(Tenant), null)
                    .WithMany()
                    .HasForeignKey(nameof(MultiTenantEntity.TenantId))
                    .HasPrincipalKey(nameof(BaseEntity.Id))
                    .OnDelete(DeleteBehavior.Restrict);
            }
        }

        modelBuilder.Entity<User>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Employee>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Department>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Team>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Role>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<RolePermission>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EmployeeRole>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EmployeePermission>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<RefreshToken>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AuditEvent>()
            .HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Location>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Building>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Floor>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Zone>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Door>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AccessController>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Reader>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Credential>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AccessProfile>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AccessRule>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EmployeeAccessProfile>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TemporaryAccessGrant>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AccessEvent>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EdgeAgent>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AttendancePolicy>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<WorkSchedule>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<WorkScheduleDay>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<ScheduleAssignment>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AttendanceSession>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AttendanceEvent>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AttendanceBreak>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AttendanceAdjustment>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EmployeePresence>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Project>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<WorkTask>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TaskAssignee>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TaskComment>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TaskActivity>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<EmployeeTeam>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Conversation>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<ConversationMember>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Message>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<MessageMention>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<MessageReaction>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<MessageReadState>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Announcement>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<AnnouncementAudience>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TenantEntitlement>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<FeatureOverride>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TenantLimitOverride>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<Subscription>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<TenantTrial>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<BillingCustomer>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<PaymentProviderReference>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<InvoiceReference>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);
        modelBuilder.Entity<BillingEvent>().HasQueryFilter(entity => entity.TenantId == CurrentTenantId && !entity.IsDeleted);

        modelBuilder.Entity<Plan>().HasData(PlanCatalog.Plans);
        modelBuilder.Entity<PlanFeature>().HasData(PlanCatalog.Features);
        modelBuilder.Entity<PlanLimit>().HasData(PlanCatalog.Limits);
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        ApplyAuditMetadata();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(
        bool acceptAllChangesOnSuccess,
        CancellationToken cancellationToken = default)
    {
        ApplyAuditMetadata();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    private void ApplyAuditMetadata()
    {
        var now = _dateTimeProvider.UtcNow;
        var userId = _currentUserService.UserId;

        foreach (var entry in ChangeTracker.Entries<AuditableEntity>())
        {
            if (entry.State == EntityState.Added)
            {
                entry.Entity.CreatedAtUtc = now;
                entry.Entity.UpdatedAtUtc = now;
                entry.Entity.CreatedByUserId = userId;
                entry.Entity.UpdatedByUserId = userId;

                if (entry.Entity is MultiTenantEntity tenantEntity && tenantEntity.TenantId == Guid.Empty)
                {
                    if (!_tenantContext.HasTenant)
                    {
                        throw new InvalidOperationException("A tenant context is required for tenant-owned entities.");
                    }

                    tenantEntity.TenantId = _tenantContext.TenantId;
                }
            }
            else if (entry.State == EntityState.Modified)
            {
                entry.Entity.UpdatedAtUtc = now;
                entry.Entity.UpdatedByUserId = userId;
            }
        }
    }
}
