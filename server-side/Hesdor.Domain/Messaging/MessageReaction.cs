namespace Hesdor.Domain.Messaging;

public sealed class MessageReaction : MultiTenantEntity
{
    public Guid MessageId { get; set; }
    public Guid UserId { get; set; }
    public string Reaction { get; set; } = default!;
}
