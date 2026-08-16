using Hesdor.Api.Hubs;
using Hesdor.Application.Realtime;
using Microsoft.AspNetCore.SignalR;

namespace Hesdor.Api.Realtime;

public sealed class SignalRRealtimeEventPublisher : IRealtimeEventPublisher
{
    private readonly IHubContext<HesdorHub> _hubContext;

    public SignalRRealtimeEventPublisher(IHubContext<HesdorHub> hubContext)
    {
        _hubContext = hubContext;
    }

    public Task PublishAsync(Guid tenantId, string eventName, object payload, CancellationToken cancellationToken = default)
    {
        return _hubContext.Clients.Group(HesdorHub.TenantGroup(tenantId)).SendAsync(eventName, payload, cancellationToken);
    }

    public Task PublishToConversationAsync(Guid tenantId, Guid conversationId, string eventName, object payload, CancellationToken cancellationToken = default)
    {
        return _hubContext.Clients.Group(HesdorHub.ConversationGroup(tenantId, conversationId)).SendAsync(eventName, payload, cancellationToken);
    }
}
