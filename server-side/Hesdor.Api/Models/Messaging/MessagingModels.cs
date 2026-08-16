using System.ComponentModel.DataAnnotations;
using Hesdor.Domain.Messaging;

namespace Hesdor.Api.Models.Messaging;

public sealed class CreateConversationRequest
{
    public ConversationType Type { get; set; } = ConversationType.Direct;
    public ConversationScope Scope { get; set; } = ConversationScope.Private;
    [StringLength(200)] public string? Name { get; set; }
    public IReadOnlyCollection<Guid> MemberUserIds { get; set; } = Array.Empty<Guid>();
    public Guid? DepartmentId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid? ProjectId { get; set; }
}

public sealed class SendMessageRequest
{
    [Required] public string Content { get; set; } = string.Empty;
    public Guid? ReplyToMessageId { get; set; }
    public IReadOnlyCollection<MessageMentionRequest> Mentions { get; set; } = Array.Empty<MessageMentionRequest>();
}

public sealed class MessageMentionRequest
{
    [Required] public Guid MentionedUserId { get; set; }
    public int StartIndex { get; set; }
    public int Length { get; set; }
}

public sealed class UpdateMessageRequest
{
    [Required] public string Content { get; set; } = string.Empty;
}

public sealed class ReactionRequest
{
    [Required, StringLength(80)] public string Reaction { get; set; } = string.Empty;
}

public sealed class MarkConversationReadRequest
{
    public Guid? LastReadMessageId { get; set; }
}

public sealed class CreateAnnouncementRequest
{
    [Required, StringLength(240)] public string Title { get; set; } = string.Empty;
    [Required] public string Body { get; set; } = string.Empty;
    public AnnouncementStatus Status { get; set; } = AnnouncementStatus.Draft;
    public DateTime? PublishedAtUtc { get; set; }
    public DateTime? ExpiresAtUtc { get; set; }
    public IReadOnlyCollection<AnnouncementAudienceRequest> Audiences { get; set; } = Array.Empty<AnnouncementAudienceRequest>();
}

public sealed class AnnouncementAudienceRequest
{
    public AnnouncementAudienceType Type { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid? EmployeeId { get; set; }
}

public sealed record ConversationResponse(Guid Id, ConversationType Type, ConversationScope Scope, string? Name, DateTime? LastMessageAtUtc);

public sealed record MessageResponse(Guid Id, Guid ConversationId, Guid SenderUserId, Guid? SenderEmployeeId, string Content, Guid? ReplyToMessageId, DateTime CreatedAtUtc, DateTime? EditedAtUtc, bool IsDeleted);

public sealed record MessageReactionResponse(Guid MessageId, Guid UserId, string Reaction);

public sealed record AnnouncementResponse(Guid Id, string Title, string Body, AnnouncementStatus Status, DateTime? PublishedAtUtc, DateTime? ExpiresAtUtc, DateTime CreatedAtUtc);
