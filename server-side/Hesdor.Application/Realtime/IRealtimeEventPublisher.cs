namespace Hesdor.Application.Realtime;

public interface IRealtimeEventPublisher
{
    Task PublishAsync(
        Guid tenantId,
        string eventName,
        object payload,
        CancellationToken cancellationToken = default);

    Task PublishToConversationAsync(
        Guid tenantId,
        Guid conversationId,
        string eventName,
        object payload,
        CancellationToken cancellationToken = default);
}
