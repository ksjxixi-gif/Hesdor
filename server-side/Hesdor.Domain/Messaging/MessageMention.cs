namespace Hesdor.Domain.Messaging;

public sealed class MessageMention : MultiTenantEntity
{
    public Guid MessageId { get; set; }
    public Guid MentionedUserId { get; set; }
    public int StartIndex { get; set; }
    public int Length { get; set; }
}
