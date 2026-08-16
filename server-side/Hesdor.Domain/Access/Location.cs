namespace Hesdor.Domain.Access;

public sealed class Location : MultiTenantEntity
{
    public string Name { get; set; } = default!;
    public string Code { get; set; } = default!;
    public string? AddressLine1 { get; set; }
    public string? AddressLine2 { get; set; }
    public string? City { get; set; }
    public string? CountryCode { get; set; }
    public string TimeZone { get; set; } = "UTC";
    public LocationStatus Status { get; set; } = LocationStatus.Active;
}

public enum LocationStatus
{
    Active = 0,
    Inactive = 1,
    Archived = 2
}
