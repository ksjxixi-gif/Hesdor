namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class AttendancePolicyConfiguration : IEntityTypeConfiguration<AttendancePolicy>
{
    public void Configure(EntityTypeBuilder<AttendancePolicy> builder)
    {
        builder.ToTable("attendance_policies", table =>
        {
            table.HasCheckConstraint("CK_attendance_policies_late_grace", "\"LateGraceMinutes\" >= 0");
            table.HasCheckConstraint("CK_attendance_policies_overtime_grace", "\"OvertimeGraceMinutes\" >= 0");
        });
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Name }).IsUnique();
    }
}

public sealed class WorkScheduleConfiguration : IEntityTypeConfiguration<WorkSchedule>
{
    public void Configure(EntityTypeBuilder<WorkSchedule> builder)
    {
        builder.ToTable("work_schedules");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(160).IsRequired();
        builder.Property(entity => entity.TimeZone).HasMaxLength(100).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.Name }).IsUnique();
    }
}

public sealed class WorkScheduleDayConfiguration : IEntityTypeConfiguration<WorkScheduleDay>
{
    public void Configure(EntityTypeBuilder<WorkScheduleDay> builder)
    {
        builder.ToTable("work_schedule_days", table => table.HasCheckConstraint("CK_work_schedule_days_break", "\"BreakMinutes\" >= 0"));
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.DayOfWeek).HasConversion<string>().HasMaxLength(16);
        builder.HasIndex(entity => new { entity.TenantId, entity.WorkScheduleId, entity.DayOfWeek }).IsUnique();
        builder.HasOne<WorkSchedule>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.WorkScheduleId }).HasPrincipalKey(schedule => new { schedule.TenantId, schedule.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class ScheduleAssignmentConfiguration : IEntityTypeConfiguration<ScheduleAssignment>
{
    public void Configure(EntityTypeBuilder<ScheduleAssignment> builder)
    {
        builder.ToTable("schedule_assignments");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.ValidFromUtc, entity.ValidToUtc });
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<WorkSchedule>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.WorkScheduleId }).HasPrincipalKey(schedule => new { schedule.TenantId, schedule.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<AttendancePolicy>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AttendancePolicyId }).HasPrincipalKey(policy => new { policy.TenantId, policy.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AttendanceSessionConfiguration : IEntityTypeConfiguration<AttendanceSession>
{
    public void Configure(EntityTypeBuilder<AttendanceSession> builder)
    {
        builder.ToTable("attendance_sessions");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.WorkDate).HasColumnType("date");
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Source).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.WorkDate });
        builder.HasIndex(entity => new { entity.TenantId, entity.WorkDate });
        builder.HasIndex(entity => new { entity.TenantId, entity.Status, entity.WorkDate });
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.WorkDate, entity.Sequence }).IsUnique();
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AttendanceEventConfiguration : IEntityTypeConfiguration<AttendanceEvent>
{
    public void Configure(EntityTypeBuilder<AttendanceEvent> builder)
    {
        builder.ToTable("attendance_events");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Source).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.ExternalEventId).HasMaxLength(200);
        builder.Property(entity => entity.Notes).HasMaxLength(1000);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.AttendanceSessionId, entity.OccurredAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExternalEventId }).IsUnique().HasFilter("\"ExternalEventId\" IS NOT NULL");
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<AttendanceSession>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AttendanceSessionId }).HasPrincipalKey(session => new { session.TenantId, session.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AttendanceBreakConfiguration : IEntityTypeConfiguration<AttendanceBreak>
{
    public void Configure(EntityTypeBuilder<AttendanceBreak> builder)
    {
        builder.ToTable("attendance_breaks");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.AttendanceSessionId, entity.StartedAtUtc });
        builder.HasOne<AttendanceSession>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AttendanceSessionId }).HasPrincipalKey(session => new { session.TenantId, session.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AttendanceAdjustmentConfiguration : IEntityTypeConfiguration<AttendanceAdjustment>
{
    public void Configure(EntityTypeBuilder<AttendanceAdjustment> builder)
    {
        builder.ToTable("attendance_adjustments");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Reason).HasMaxLength(500).IsRequired();
        builder.Property(entity => entity.PreviousValue).HasColumnType("text");
        builder.Property(entity => entity.NewValue).HasColumnType("text");
        builder.HasIndex(entity => new { entity.TenantId, entity.AttendanceSessionId, entity.CreatedAtUtc });
        builder.HasOne<AttendanceSession>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AttendanceSessionId }).HasPrincipalKey(session => new { session.TenantId, session.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class EmployeePresenceConfiguration : IEntityTypeConfiguration<EmployeePresence>
{
    public void Configure(EntityTypeBuilder<EmployeePresence> builder)
    {
        builder.ToTable("employee_presence");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.State).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.State, entity.UpdatedAtUtc });
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
