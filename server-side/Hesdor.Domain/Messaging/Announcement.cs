namespace Hesdor.Domain.Messaging;

public sealed class Announcement : MultiTenantEntity
{
    public string Title { get; set; } = default!;
    public string Body { get; set; } = default!;
    public AnnouncementStatus Status { get; set; } = AnnouncementStatus.Draft;
    public DateTime? PublishedAtUtc { get; set; }
    public DateTime? ExpiresAtUtc { get; set; }
}

public enum AnnouncementStatus
{
    Draft = 0,
    Published = 1,
    Archived = 2
}
