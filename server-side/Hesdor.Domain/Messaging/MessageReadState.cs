namespace Hesdor.Domain.Messaging;

public sealed class MessageReadState : MultiTenantEntity
{
    public Guid ConversationId { get; set; }
    public Guid UserId { get; set; }
    public Guid? LastReadMessageId { get; set; }
    public DateTime LastReadAtUtc { get; set; }
}
