using Hesdor.Domain.Organizations;

namespace Hesdor.Api.Models.Organizations;

public sealed record TenantResponse(
    Guid Id,
    string Name,
    string Slug,
    TenantPlan Plan,
    TenantStatus Status,
    string? TimeZone,
    string? Locale);
