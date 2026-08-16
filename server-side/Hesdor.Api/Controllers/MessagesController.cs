using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Messaging;
using Hesdor.Application.Messaging;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/messages")]
public sealed class MessagesController : ControllerBase
{
    private readonly IMessagingService _messagingService;

    public MessagesController(IMessagingService messagingService)
    {
        _messagingService = messagingService;
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission("messages.send")]
    public async Task<IActionResult> Update(Guid id, UpdateMessageRequest request, CancellationToken cancellationToken)
    {
        var result = await _messagingService.UpdateMessageAsync(new UpdateMessageCommand(id, request.Content), cancellationToken);
        return result.Succeeded && result.Value is not null ? Ok(new MessageResponse(result.Value.Id, result.Value.ConversationId, result.Value.SenderUserId, result.Value.SenderEmployeeId, result.Value.Content, result.Value.ReplyToMessageId, result.Value.CreatedAtUtc, result.Value.EditedAtUtc, result.Value.IsDeleted)) : BadRequest(new ProblemDetails { Title = "Message was not updated.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpDelete("{id:guid}")]
    [RequirePermission("messages.send")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken cancellationToken)
    {
        var result = await _messagingService.DeleteMessageAsync(new DeleteMessageCommand(id), cancellationToken);
        return result.Succeeded ? NoContent() : BadRequest(new ProblemDetails { Title = "Message was not deleted.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpPost("{id:guid}/reactions")]
    [RequirePermission("messages.send")]
    public async Task<IActionResult> AddReaction(Guid id, ReactionRequest request, CancellationToken cancellationToken)
    {
        var result = await _messagingService.AddReactionAsync(new AddReactionCommand(id, request.Reaction), cancellationToken);
        return result.Succeeded && result.Value is not null ? Ok(new MessageReactionResponse(result.Value.MessageId, result.Value.UserId, result.Value.Reaction)) : BadRequest(new ProblemDetails { Title = "Reaction was not added.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpDelete("{id:guid}/reactions/{reaction}")]
    [RequirePermission("messages.send")]
    public async Task<IActionResult> RemoveReaction(Guid id, string reaction, CancellationToken cancellationToken)
    {
        var result = await _messagingService.RemoveReactionAsync(new RemoveReactionCommand(id, reaction), cancellationToken);
        return result.Succeeded ? NoContent() : NotFound(new ProblemDetails { Title = "Reaction not found.", Status = StatusCodes.Status404NotFound });
    }
}
