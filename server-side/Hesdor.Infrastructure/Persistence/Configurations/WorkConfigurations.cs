namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class ProjectConfiguration : IEntityTypeConfiguration<Project>
{
    public void Configure(EntityTypeBuilder<Project> builder)
    {
        builder.ToTable("projects");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Name).HasMaxLength(200).IsRequired();
        builder.Property(entity => entity.Description).HasMaxLength(4000);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.Status, entity.UpdatedAtUtc });
        builder.HasIndex(entity => new { entity.TenantId, entity.Name }).IsUnique();
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.CreatedByEmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class WorkTaskConfiguration : IEntityTypeConfiguration<WorkTask>
{
    public void Configure(EntityTypeBuilder<WorkTask> builder)
    {
        builder.ToTable("tasks");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Title).HasMaxLength(300).IsRequired();
        builder.Property(entity => entity.Description).HasMaxLength(10000);
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Priority).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ProjectId, entity.Status });
        builder.HasIndex(entity => new { entity.TenantId, entity.DueAtUtc });
        builder.HasIndex(entity => new { entity.TenantId, entity.ParentTaskId });
        builder.HasOne<Project>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ProjectId }).HasPrincipalKey(project => new { project.TenantId, project.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.CreatedByEmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TaskAssigneeConfiguration : IEntityTypeConfiguration<TaskAssignee>
{
    public void Configure(EntityTypeBuilder<TaskAssignee> builder)
    {
        builder.ToTable("task_assignees");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.TaskId, entity.EmployeeId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.EmployeeId });
        builder.HasOne<WorkTask>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.TaskId }).HasPrincipalKey(task => new { task.TenantId, task.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.EmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TaskCommentConfiguration : IEntityTypeConfiguration<TaskComment>
{
    public void Configure(EntityTypeBuilder<TaskComment> builder)
    {
        builder.ToTable("task_comments");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Body).HasMaxLength(10000).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.TaskId, entity.CreatedAtUtc }).IsDescending(false, false, true);
        builder.HasOne<WorkTask>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.TaskId }).HasPrincipalKey(task => new { task.TenantId, task.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AuthorEmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class TaskActivityConfiguration : IEntityTypeConfiguration<TaskActivity>
{
    public void Configure(EntityTypeBuilder<TaskActivity> builder)
    {
        builder.ToTable("task_activities");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(40);
        builder.Property(entity => entity.MetadataJson).HasColumnType("jsonb");
        builder.HasIndex(entity => new { entity.TenantId, entity.TaskId, entity.CreatedAtUtc }).IsDescending(false, false, true);
        builder.HasOne<WorkTask>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.TaskId }).HasPrincipalKey(task => new { task.TenantId, task.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<Employee>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ActorEmployeeId }).HasPrincipalKey(employee => new { employee.TenantId, employee.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
