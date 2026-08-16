namespace Hesdor.Domain.Messaging;

public sealed class ConversationMember : MultiTenantEntity
{
    public Guid ConversationId { get; set; }
    public Guid UserId { get; set; }
    public ConversationMemberRole Role { get; set; } = ConversationMemberRole.Member;
    public DateTime JoinedAtUtc { get; set; }
}

public enum ConversationMemberRole
{
    Member = 0,
    Moderator = 1,
    Owner = 2
}
