using Hesdor.Domain.Messaging;

namespace Hesdor.Application.Messaging;

public sealed record MentionInput(Guid MentionedUserId, int StartIndex, int Length);

public sealed record CreateConversationCommand(
    ConversationType Type,
    ConversationScope Scope,
    string? Name,
    IReadOnlyCollection<Guid> MemberUserIds,
    Guid? DepartmentId = null,
    Guid? TeamId = null,
    Guid? ProjectId = null);

public sealed record SendMessageCommand(
    Guid ConversationId,
    string Content,
    Guid? ReplyToMessageId = null,
    IReadOnlyCollection<MentionInput>? Mentions = null);

public sealed record UpdateMessageCommand(Guid MessageId, string Content);

public sealed record DeleteMessageCommand(Guid MessageId);

public sealed record AddReactionCommand(Guid MessageId, string Reaction);

public sealed record RemoveReactionCommand(Guid MessageId, string Reaction);

public sealed record MarkConversationReadCommand(Guid ConversationId, Guid? LastReadMessageId);

public sealed record AnnouncementAudienceInput(
    AnnouncementAudienceType Type,
    Guid? DepartmentId = null,
    Guid? TeamId = null,
    Guid? EmployeeId = null);

public sealed record CreateAnnouncementCommand(
    string Title,
    string Body,
    AnnouncementStatus Status,
    DateTime? PublishedAtUtc,
    DateTime? ExpiresAtUtc,
    IReadOnlyCollection<AnnouncementAudienceInput> Audiences);

public sealed record MessagingOperationResult<T>(bool Succeeded, string? FailureReason, T? Value = default);

public interface IMessagingService
{
    Task<MessagingOperationResult<Conversation>> CreateConversationAsync(CreateConversationCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<Message>> SendMessageAsync(SendMessageCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<Message>> UpdateMessageAsync(UpdateMessageCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<bool>> DeleteMessageAsync(DeleteMessageCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<MessageReaction>> AddReactionAsync(AddReactionCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<bool>> RemoveReactionAsync(RemoveReactionCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<MessageReadState>> MarkConversationReadAsync(MarkConversationReadCommand command, CancellationToken cancellationToken = default);
    Task<MessagingOperationResult<Announcement>> CreateAnnouncementAsync(CreateAnnouncementCommand command, CancellationToken cancellationToken = default);
}
