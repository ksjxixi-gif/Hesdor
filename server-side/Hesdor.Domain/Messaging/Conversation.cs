namespace Hesdor.Domain.Messaging;

public sealed class Conversation : MultiTenantEntity
{
    public ConversationType Type { get; set; }
    public ConversationScope Scope { get; set; } = ConversationScope.Private;
    public string? Name { get; set; }
    public Guid? DepartmentId { get; set; }
    public Guid? TeamId { get; set; }
    public Guid? ProjectId { get; set; }
    public DateTime? LastMessageAtUtc { get; set; }
    public Guid? LastMessageId { get; set; }
}

public enum ConversationType
{
    Direct = 0,
    Group = 1,
    Channel = 2
}

public enum ConversationScope
{
    Company = 0,
    Department = 1,
    Team = 2,
    Project = 3,
    Private = 4
}
