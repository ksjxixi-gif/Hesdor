using System.Text.Json;
using Hesdor.Application.Audit;
using Hesdor.Application.Messaging;
using Hesdor.Application.Realtime;
using Hesdor.Domain.Messaging;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Messaging;

public sealed class MessagingService : IMessagingService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly IPermissionEvaluator _permissionEvaluator;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly IAuditWriter _auditWriter;
    private readonly IRealtimeEventPublisher _realtimeEventPublisher;

    public MessagingService(ApplicationDbContext dbContext, ITenantContext tenantContext, ICurrentUserService currentUserService, IPermissionEvaluator permissionEvaluator, IDateTimeProvider dateTimeProvider, IAuditWriter auditWriter, IRealtimeEventPublisher realtimeEventPublisher)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _currentUserService = currentUserService;
        _permissionEvaluator = permissionEvaluator;
        _dateTimeProvider = dateTimeProvider;
        _auditWriter = auditWriter;
        _realtimeEventPublisher = realtimeEventPublisher;
    }

    public async Task<MessagingOperationResult<Conversation>> CreateConversationAsync(CreateConversationCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid currentUserId || !_tenantContext.HasTenant)
        {
            return Failure<Conversation>("user_context_required");
        }

        var memberIds = command.MemberUserIds.Append(currentUserId).Distinct().ToArray();
        if (command.Type == ConversationType.Direct && memberIds.Length != 2)
        {
            return Failure<Conversation>("direct_conversation_requires_two_members");
        }

        var validMemberCount = await _dbContext.Users.IgnoreQueryFilters().CountAsync(user => user.TenantId == _tenantContext.TenantId && memberIds.Contains(user.Id) && user.Status == Hesdor.Domain.Identity.UserStatus.Active, cancellationToken);
        if (validMemberCount != memberIds.Length)
        {
            return Failure<Conversation>("conversation_members_must_belong_to_the_organization");
        }

        var conversation = new Conversation
        {
            TenantId = _tenantContext.TenantId,
            Type = command.Type,
            Scope = command.Scope,
            Name = command.Name?.Trim(),
            DepartmentId = command.DepartmentId,
            TeamId = command.TeamId,
            ProjectId = command.ProjectId,
            CreatedByUserId = currentUserId
        };
        _dbContext.Conversations.Add(conversation);
        var joinedAt = _dateTimeProvider.UtcNow;
        _dbContext.ConversationMembers.AddRange(memberIds.Select(userId => new ConversationMember
        {
            TenantId = _tenantContext.TenantId,
            ConversationId = conversation.Id,
            UserId = userId,
            Role = userId == currentUserId ? ConversationMemberRole.Owner : ConversationMemberRole.Member,
            JoinedAtUtc = joinedAt
        }));
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "conversation.created", nameof(Conversation), conversation.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "conversation.created", new { conversation.Id, conversation.Type, conversation.Scope }, cancellationToken);
        return Success(conversation);
    }

    public async Task<MessagingOperationResult<Message>> SendMessageAsync(SendMessageCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid senderUserId || !_tenantContext.HasTenant)
        {
            return Failure<Message>("user_context_required");
        }
        if (string.IsNullOrWhiteSpace(command.Content))
        {
            return Failure<Message>("message_content_required");
        }
        if (!await IsMemberAsync(command.ConversationId, senderUserId, cancellationToken))
        {
            return Failure<Message>("conversation_membership_required");
        }

        var conversation = await _dbContext.Conversations.SingleOrDefaultAsync(item => item.Id == command.ConversationId, cancellationToken);
        if (conversation is null)
        {
            return Failure<Message>("conversation_not_found");
        }

        if (command.ReplyToMessageId is Guid replyToMessageId && !await _dbContext.Messages.AnyAsync(message => message.Id == replyToMessageId && message.ConversationId == command.ConversationId, cancellationToken))
        {
            return Failure<Message>("reply_message_not_found");
        }

        var mentions = command.Mentions ?? Array.Empty<MentionInput>();
        var mentionedUserIds = mentions.Select(mention => mention.MentionedUserId).Distinct().ToArray();
        if (mentionedUserIds.Length > 0 && await _dbContext.Users.IgnoreQueryFilters().CountAsync(user => user.TenantId == _tenantContext.TenantId && mentionedUserIds.Contains(user.Id), cancellationToken) != mentionedUserIds.Length)
        {
            return Failure<Message>("message_mentions_must_belong_to_the_organization");
        }

        var message = new Message
        {
            TenantId = _tenantContext.TenantId,
            ConversationId = command.ConversationId,
            SenderUserId = senderUserId,
            SenderEmployeeId = await GetActorEmployeeIdAsync(cancellationToken),
            Content = command.Content.Trim(),
            ReplyToMessageId = command.ReplyToMessageId
        };
        _dbContext.Messages.Add(message);
        _dbContext.MessageMentions.AddRange(mentions.Select(mention => new MessageMention
        {
            TenantId = _tenantContext.TenantId,
            MessageId = message.Id,
            MentionedUserId = mention.MentionedUserId,
            StartIndex = mention.StartIndex,
            Length = mention.Length
        }));
        conversation.LastMessageAtUtc = _dateTimeProvider.UtcNow;
        conversation.LastMessageId = message.Id;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "message.created", nameof(Message), message.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, command.ConversationId, "message.created", new { message.Id, message.ConversationId, message.SenderUserId, message.Content, message.CreatedAtUtc }, cancellationToken);
        return Success(message);
    }

    public async Task<MessagingOperationResult<Message>> UpdateMessageAsync(UpdateMessageCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await IsMemberAsyncForMessage(command.MessageId, userId, cancellationToken))
        {
            return Failure<Message>("message_membership_required");
        }

        var message = await _dbContext.Messages.SingleOrDefaultAsync(item => item.Id == command.MessageId, cancellationToken);
        if (message is null || message.IsDeleted)
        {
            return Failure<Message>("message_not_found");
        }
        if (message.SenderUserId != userId && !await _permissionEvaluator.HasPermissionAsync("channels.manage", cancellationToken))
        {
            return Failure<Message>("message_update_not_authorized");
        }
        if (string.IsNullOrWhiteSpace(command.Content))
        {
            return Failure<Message>("message_content_required");
        }

        message.Content = command.Content.Trim();
        message.EditedAtUtc = _dateTimeProvider.UtcNow;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "message.updated", nameof(Message), message.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, message.ConversationId, "message.updated", new { message.Id, message.ConversationId, message.Content, message.EditedAtUtc }, cancellationToken);
        return Success(message);
    }

    public async Task<MessagingOperationResult<bool>> DeleteMessageAsync(DeleteMessageCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await IsMemberAsyncForMessage(command.MessageId, userId, cancellationToken))
        {
            return Failure<bool>("message_membership_required");
        }

        var message = await _dbContext.Messages.SingleOrDefaultAsync(item => item.Id == command.MessageId, cancellationToken);
        if (message is null || message.IsDeleted)
        {
            return Failure<bool>("message_not_found");
        }
        if (message.SenderUserId != userId && !await _permissionEvaluator.HasPermissionAsync("channels.manage", cancellationToken))
        {
            return Failure<bool>("message_delete_not_authorized");
        }

        message.IsDeleted = true;
        message.DeletedAtUtc = _dateTimeProvider.UtcNow;
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "message.deleted", nameof(Message), message.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, message.ConversationId, "message.deleted", new { message.Id, message.ConversationId }, cancellationToken);
        return Success(true);
    }

    public async Task<MessagingOperationResult<MessageReaction>> AddReactionAsync(AddReactionCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await IsMemberAsyncForMessage(command.MessageId, userId, cancellationToken))
        {
            return Failure<MessageReaction>("message_membership_required");
        }
        var message = await _dbContext.Messages.SingleOrDefaultAsync(item => item.Id == command.MessageId, cancellationToken);
        if (message is null || string.IsNullOrWhiteSpace(command.Reaction)) return Failure<MessageReaction>("message_not_found_or_reaction_empty");
        var reaction = command.Reaction.Trim();
        if (await _dbContext.MessageReactions.AnyAsync(item => item.MessageId == command.MessageId && item.UserId == userId && item.Reaction == reaction, cancellationToken)) return Failure<MessageReaction>("reaction_already_exists");

        var entity = new MessageReaction { TenantId = _tenantContext.TenantId, MessageId = command.MessageId, UserId = userId, Reaction = reaction };
        _dbContext.MessageReactions.Add(entity);
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "message.reaction.added", nameof(MessageReaction), entity.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, message.ConversationId, "message.reaction.added", new { entity.MessageId, entity.UserId, entity.Reaction }, cancellationToken);
        return Success(entity);
    }

    public async Task<MessagingOperationResult<bool>> RemoveReactionAsync(RemoveReactionCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await IsMemberAsyncForMessage(command.MessageId, userId, cancellationToken)) return Failure<bool>("message_membership_required");
        var message = await _dbContext.Messages.SingleOrDefaultAsync(item => item.Id == command.MessageId, cancellationToken);
        var reaction = await _dbContext.MessageReactions.SingleOrDefaultAsync(item => item.MessageId == command.MessageId && item.UserId == userId && item.Reaction == command.Reaction.Trim(), cancellationToken);
        if (message is null || reaction is null) return Failure<bool>("reaction_not_found");
        _dbContext.MessageReactions.Remove(reaction);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, message.ConversationId, "message.reaction.removed", new { reaction.MessageId, reaction.UserId, reaction.Reaction }, cancellationToken);
        return Success(true);
    }

    public async Task<MessagingOperationResult<MessageReadState>> MarkConversationReadAsync(MarkConversationReadCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await IsMemberAsync(command.ConversationId, userId, cancellationToken)) return Failure<MessageReadState>("conversation_membership_required");
        if (command.LastReadMessageId is Guid messageId && !await _dbContext.Messages.AnyAsync(message => message.Id == messageId && message.ConversationId == command.ConversationId, cancellationToken)) return Failure<MessageReadState>("last_read_message_not_found");
        var state = await _dbContext.MessageReadStates.SingleOrDefaultAsync(item => item.ConversationId == command.ConversationId && item.UserId == userId, cancellationToken);
        if (state is null)
        {
            state = new MessageReadState { TenantId = _tenantContext.TenantId, ConversationId = command.ConversationId, UserId = userId };
            _dbContext.MessageReadStates.Add(state);
        }
        state.LastReadMessageId = command.LastReadMessageId;
        state.LastReadAtUtc = _dateTimeProvider.UtcNow;
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishToConversationAsync(_tenantContext.TenantId, command.ConversationId, "conversation.read", new { command.ConversationId, userId, state.LastReadMessageId, state.LastReadAtUtc }, cancellationToken);
        return Success(state);
    }

    public async Task<MessagingOperationResult<Announcement>> CreateAnnouncementAsync(CreateAnnouncementCommand command, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || string.IsNullOrWhiteSpace(command.Title) || string.IsNullOrWhiteSpace(command.Body)) return Failure<Announcement>("user_title_and_body_required");
        var announcement = new Announcement
        {
            TenantId = _tenantContext.TenantId,
            Title = command.Title.Trim(),
            Body = command.Body.Trim(),
            Status = command.Status,
            CreatedByUserId = userId,
            PublishedAtUtc = command.Status == AnnouncementStatus.Published ? command.PublishedAtUtc ?? _dateTimeProvider.UtcNow : null,
            ExpiresAtUtc = command.ExpiresAtUtc
        };
        _dbContext.Announcements.Add(announcement);
        var audiences = command.Audiences.Count == 0 ? [new AnnouncementAudienceInput(AnnouncementAudienceType.Company)] : command.Audiences;
        _dbContext.AnnouncementAudiences.AddRange(audiences.Select(audience => new AnnouncementAudience { TenantId = _tenantContext.TenantId, AnnouncementId = announcement.Id, Type = audience.Type, DepartmentId = audience.DepartmentId, TeamId = audience.TeamId, EmployeeId = audience.EmployeeId }));
        await _auditWriter.RecordAsync(new AuditEventInput(_tenantContext.TenantId, "announcement.created", nameof(Announcement), announcement.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        await _realtimeEventPublisher.PublishAsync(_tenantContext.TenantId, "announcement.created", new { announcement.Id, announcement.Title, announcement.Status }, cancellationToken);
        return Success(announcement);
    }

    private async Task<bool> IsMemberAsync(Guid conversationId, Guid userId, CancellationToken cancellationToken) => await _dbContext.ConversationMembers.AnyAsync(member => member.ConversationId == conversationId && member.UserId == userId, cancellationToken);

    private async Task<bool> IsMemberAsyncForMessage(Guid messageId, Guid userId, CancellationToken cancellationToken)
    {
        var conversationId = await _dbContext.Messages.Where(message => message.Id == messageId).Select(message => (Guid?)message.ConversationId).SingleOrDefaultAsync(cancellationToken);
        return conversationId is Guid id && await IsMemberAsync(id, userId, cancellationToken);
    }

    private async Task<Guid?> GetActorEmployeeIdAsync(CancellationToken cancellationToken)
    {
        if (_currentUserService.UserId is not Guid userId) return null;
        return await _dbContext.Users.IgnoreQueryFilters().Where(user => user.Id == userId && user.TenantId == _tenantContext.TenantId).Select(user => user.EmployeeId).SingleOrDefaultAsync(cancellationToken);
    }

    private static MessagingOperationResult<T> Success<T>(T value) => new(true, null, value);
    private static MessagingOperationResult<T> Failure<T>(string reason) => new(false, reason);
}
