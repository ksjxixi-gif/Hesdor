namespace Hesdor.Domain.Messaging;

public sealed class Message : MultiTenantEntity
{
    public Guid ConversationId { get; set; }
    public Guid SenderUserId { get; set; }
    public Guid? SenderEmployeeId { get; set; }
    public string Content { get; set; } = default!;
    public Guid? ReplyToMessageId { get; set; }
    public DateTime? EditedAtUtc { get; set; }
    public DateTime? DeletedAtUtc { get; set; }
}
