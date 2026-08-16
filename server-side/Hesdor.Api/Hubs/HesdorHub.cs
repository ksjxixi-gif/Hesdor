using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Hesdor.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Hubs;

[Authorize]
public sealed class HesdorHub : Hub
{
    private readonly ApplicationDbContext _dbContext;

    public HesdorHub(ApplicationDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public override async Task OnConnectedAsync()
    {
        var tenantClaim = Context.User?.FindFirst("tid")?.Value;
        if (Guid.TryParse(tenantClaim, out var tenantId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, TenantGroup(tenantId));
        }

        await base.OnConnectedAsync();
    }

    public async Task<bool> JoinConversation(Guid conversationId)
    {
        if (!TryGetIdentity(out var tenantId, out var userId))
        {
            return false;
        }

        var isMember = await _dbContext.ConversationMembers
            .IgnoreQueryFilters()
            .AnyAsync(member => member.TenantId == tenantId && member.ConversationId == conversationId && member.UserId == userId, Context.ConnectionAborted);
        if (!isMember)
        {
            return false;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, ConversationGroup(tenantId, conversationId), Context.ConnectionAborted);
        return true;
    }

    public async Task LeaveConversation(Guid conversationId)
    {
        if (TryGetIdentity(out var tenantId, out _))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, ConversationGroup(tenantId, conversationId), Context.ConnectionAborted);
        }
    }

    public static string TenantGroup(Guid tenantId) => $"tenant:{tenantId:N}";
    public static string ConversationGroup(Guid tenantId, Guid conversationId) => $"tenant:{tenantId:N}:conversation:{conversationId:N}";

    private bool TryGetIdentity(out Guid tenantId, out Guid userId)
    {
        tenantId = Guid.Empty;
        userId = Guid.Empty;
        var hasTenant = Guid.TryParse(Context.User?.FindFirst("tid")?.Value, out tenantId);
        var hasUser = Guid.TryParse(Context.User?.FindFirst("sub")?.Value, out userId);
        return hasTenant && hasUser;
    }
}
