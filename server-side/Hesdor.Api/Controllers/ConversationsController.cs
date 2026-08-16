using System.Text;
using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Messaging;
using Hesdor.Application.Messaging;
using Hesdor.Application.Authorization;
using Hesdor.Application.Common;
using Hesdor.Domain.Messaging;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/conversations")]
public sealed class ConversationsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly IPermissionEvaluator _permissionEvaluator;
    private readonly IMessagingService _messagingService;

    public ConversationsController(ApplicationDbContext dbContext, ICurrentUserService currentUserService, IPermissionEvaluator permissionEvaluator, IMessagingService messagingService)
    {
        _dbContext = dbContext;
        _currentUserService = currentUserService;
        _permissionEvaluator = permissionEvaluator;
        _messagingService = messagingService;
    }

    [HttpGet]
    [RequirePermission("messages.read")]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        if (_currentUserService.UserId is not Guid userId) return Unauthorized();
        var conversations = await (from member in _dbContext.ConversationMembers.AsNoTracking()
                                   join conversation in _dbContext.Conversations.AsNoTracking() on member.ConversationId equals conversation.Id
                                   where member.UserId == userId
                                   orderby conversation.LastMessageAtUtc descending
                                   select new ConversationResponse(conversation.Id, conversation.Type, conversation.Scope, conversation.Name, conversation.LastMessageAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(conversations);
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateConversationRequest request, CancellationToken cancellationToken)
    {
        var requiredPermission = request.Type == ConversationType.Channel ? "channels.manage" : "messages.send";
        if (!await _permissionEvaluator.HasPermissionAsync(requiredPermission, cancellationToken)) return Forbid();
        var result = await _messagingService.CreateConversationAsync(new CreateConversationCommand(request.Type, request.Scope, request.Name, request.MemberUserIds, request.DepartmentId, request.TeamId, request.ProjectId), cancellationToken);
        return result.Succeeded && result.Value is not null ? Created($"/api/conversations/{result.Value.Id}", ToResponse(result.Value)) : BadRequest(new ProblemDetails { Title = "Conversation creation failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpGet("{id:guid}/messages")]
    [RequirePermission("messages.read")]
    public async Task<IActionResult> GetMessages(Guid id, [FromQuery] string? cursor, [FromQuery] int pageSize = 50, CancellationToken cancellationToken = default)
    {
        if (_currentUserService.UserId is not Guid userId || !await _dbContext.ConversationMembers.AnyAsync(member => member.ConversationId == id && member.UserId == userId, cancellationToken)) return Forbid();
        pageSize = Math.Clamp(pageSize, 1, 100);
        var query = _dbContext.Messages.AsNoTracking().Where(message => message.ConversationId == id);
        if (TryDecodeCursor(cursor, out var cursorDate, out var cursorId))
        {
            query = query.Where(message => message.CreatedAtUtc < cursorDate || message.CreatedAtUtc == cursorDate && message.Id.CompareTo(cursorId) < 0);
        }
        var messages = await query.OrderByDescending(message => message.CreatedAtUtc).ThenByDescending(message => message.Id).Take(pageSize + 1).ToArrayAsync(cancellationToken);
        var hasMore = messages.Length > pageSize;
        var page = messages.Take(pageSize).Select(ToResponse).ToArray();
        var nextCursor = hasMore && messages.Length > 0 ? EncodeCursor(messages[page.Length - 1].CreatedAtUtc, messages[page.Length - 1].Id) : null;
        return Ok(new { items = page, nextCursor });
    }

    [HttpPost("{id:guid}/messages")]
    [RequirePermission("messages.send")]
    public async Task<IActionResult> SendMessage(Guid id, SendMessageRequest request, CancellationToken cancellationToken)
    {
        var result = await _messagingService.SendMessageAsync(new SendMessageCommand(id, request.Content, request.ReplyToMessageId, request.Mentions.Select(mention => new MentionInput(mention.MentionedUserId, mention.StartIndex, mention.Length)).ToArray()), cancellationToken);
        return result.Succeeded && result.Value is not null ? Created($"/api/messages/{result.Value.Id}", ToResponse(result.Value)) : BadRequest(new ProblemDetails { Title = "Message was not sent.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpPost("{id:guid}/read")]
    [RequirePermission("messages.read")]
    public async Task<IActionResult> MarkRead(Guid id, MarkConversationReadRequest request, CancellationToken cancellationToken)
    {
        var result = await _messagingService.MarkConversationReadAsync(new MarkConversationReadCommand(id, request.LastReadMessageId), cancellationToken);
        return result.Succeeded ? Ok(result.Value) : BadRequest(new ProblemDetails { Title = "Conversation read state was not updated.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    private static ConversationResponse ToResponse(Conversation conversation) => new(conversation.Id, conversation.Type, conversation.Scope, conversation.Name, conversation.LastMessageAtUtc);
    private static MessageResponse ToResponse(Message message) => new(message.Id, message.ConversationId, message.SenderUserId, message.SenderEmployeeId, message.IsDeleted ? "[deleted]" : message.Content, message.ReplyToMessageId, message.CreatedAtUtc, message.EditedAtUtc, message.IsDeleted);

    private static string EncodeCursor(DateTime createdAtUtc, Guid id)
    {
        var value = $"{createdAtUtc.Ticks}:{id:N}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static bool TryDecodeCursor(string? cursor, out DateTime createdAtUtc, out Guid id)
    {
        createdAtUtc = default;
        id = default;
        if (string.IsNullOrWhiteSpace(cursor)) return false;
        try
        {
            var padded = cursor.Replace('-', '+').Replace('_', '/');
            padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(padded)).Split(':', 2);
            return parts.Length == 2 && long.TryParse(parts[0], out var ticks) && Guid.TryParse(parts[1], out id) && (createdAtUtc = new DateTime(ticks, DateTimeKind.Utc)) != default;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
