namespace Hesdor.Infrastructure.Persistence.Configurations;

public sealed class ConversationConfiguration : IEntityTypeConfiguration<Conversation>
{
    public void Configure(EntityTypeBuilder<Conversation> builder)
    {
        builder.ToTable("conversations");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Scope).HasConversion<string>().HasMaxLength(32);
        builder.Property(entity => entity.Name).HasMaxLength(200);
        builder.HasIndex(entity => new { entity.TenantId, entity.LastMessageAtUtc }).IsDescending(false, true);
    }
}

public sealed class ConversationMemberConfiguration : IEntityTypeConfiguration<ConversationMember>
{
    public void Configure(EntityTypeBuilder<ConversationMember> builder)
    {
        builder.ToTable("conversation_members");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Role).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.ConversationId, entity.UserId }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.UserId, entity.ConversationId });
        builder.HasOne<Conversation>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ConversationId }).HasPrincipalKey(conversation => new { conversation.TenantId, conversation.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.UserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class MessageConfiguration : IEntityTypeConfiguration<Message>
{
    public void Configure(EntityTypeBuilder<Message> builder)
    {
        builder.ToTable("messages");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Content).HasColumnType("text").IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.ConversationId, entity.CreatedAtUtc, entity.Id }).IsDescending(false, false, true, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.SenderUserId, entity.CreatedAtUtc }).IsDescending(false, false, true);
        builder.HasOne<Conversation>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ConversationId }).HasPrincipalKey(conversation => new { conversation.TenantId, conversation.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.SenderUserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class MessageMentionConfiguration : IEntityTypeConfiguration<MessageMention>
{
    public void Configure(EntityTypeBuilder<MessageMention> builder)
    {
        builder.ToTable("message_mentions");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.MessageId, entity.MentionedUserId }).IsUnique();
        builder.HasOne<Message>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.MessageId }).HasPrincipalKey(message => new { message.TenantId, message.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.MentionedUserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class MessageReactionConfiguration : IEntityTypeConfiguration<MessageReaction>
{
    public void Configure(EntityTypeBuilder<MessageReaction> builder)
    {
        builder.ToTable("message_reactions");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Reaction).HasMaxLength(80).IsRequired();
        builder.HasIndex(entity => new { entity.TenantId, entity.MessageId, entity.UserId, entity.Reaction }).IsUnique();
        builder.HasIndex(entity => new { entity.TenantId, entity.MessageId });
        builder.HasOne<Message>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.MessageId }).HasPrincipalKey(message => new { message.TenantId, message.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.UserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class MessageReadStateConfiguration : IEntityTypeConfiguration<MessageReadState>
{
    public void Configure(EntityTypeBuilder<MessageReadState> builder)
    {
        builder.ToTable("message_read_states");
        builder.HasKey(entity => entity.Id);
        builder.HasIndex(entity => new { entity.TenantId, entity.ConversationId, entity.UserId }).IsUnique();
        builder.HasOne<Conversation>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.ConversationId }).HasPrincipalKey(conversation => new { conversation.TenantId, conversation.Id }).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<User>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.UserId }).HasPrincipalKey(user => new { user.TenantId, user.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class AnnouncementConfiguration : IEntityTypeConfiguration<Announcement>
{
    public void Configure(EntityTypeBuilder<Announcement> builder)
    {
        builder.ToTable("announcements");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Title).HasMaxLength(240).IsRequired();
        builder.Property(entity => entity.Body).HasColumnType("text").IsRequired();
        builder.Property(entity => entity.Status).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.Status, entity.PublishedAtUtc }).IsDescending(false, false, true);
        builder.HasIndex(entity => new { entity.TenantId, entity.ExpiresAtUtc });
    }
}

public sealed class AnnouncementAudienceConfiguration : IEntityTypeConfiguration<AnnouncementAudience>
{
    public void Configure(EntityTypeBuilder<AnnouncementAudience> builder)
    {
        builder.ToTable("announcement_audiences");
        builder.HasKey(entity => entity.Id);
        builder.Property(entity => entity.Type).HasConversion<string>().HasMaxLength(32);
        builder.HasIndex(entity => new { entity.TenantId, entity.AnnouncementId, entity.Type, entity.DepartmentId, entity.TeamId, entity.EmployeeId }).IsUnique();
        builder.HasOne<Announcement>().WithMany().HasForeignKey(entity => new { entity.TenantId, entity.AnnouncementId }).HasPrincipalKey(announcement => new { announcement.TenantId, announcement.Id }).OnDelete(DeleteBehavior.Restrict);
    }
}
