using System.Security.Cryptography;
using System.Text;

namespace Hesdor.Domain.Billing;

public static class PlanCatalog
{
    private static readonly DateTime SeedDateUtc = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    public static readonly Guid FreePlanId = Guid.Parse("10000000-0000-0000-0000-000000000001");
    public static readonly Guid StarterPlanId = Guid.Parse("10000000-0000-0000-0000-000000000002");
    public static readonly Guid BusinessPlanId = Guid.Parse("10000000-0000-0000-0000-000000000003");
    public static readonly Guid EnterprisePlanId = Guid.Parse("10000000-0000-0000-0000-000000000004");

    public static IReadOnlyCollection<Plan> Plans { get; } =
    [
        new Plan { Id = FreePlanId, Code = "free", Name = "Free", MonthlyPrice = 0, AnnualPrice = 0, CurrencyCode = "USD", IsActive = true, CreatedAtUtc = SeedDateUtc, UpdatedAtUtc = SeedDateUtc },
        new Plan { Id = StarterPlanId, Code = "starter", Name = "Starter", MonthlyPrice = 49, AnnualPrice = 490, CurrencyCode = "USD", IsActive = true, CreatedAtUtc = SeedDateUtc, UpdatedAtUtc = SeedDateUtc },
        new Plan { Id = BusinessPlanId, Code = "business", Name = "Business", MonthlyPrice = 199, AnnualPrice = 1990, CurrencyCode = "USD", IsActive = true, CreatedAtUtc = SeedDateUtc, UpdatedAtUtc = SeedDateUtc },
        new Plan { Id = EnterprisePlanId, Code = "enterprise", Name = "Enterprise", MonthlyPrice = 0, AnnualPrice = 0, CurrencyCode = "USD", IsActive = true, CreatedAtUtc = SeedDateUtc, UpdatedAtUtc = SeedDateUtc },
    ];

    public static IReadOnlyCollection<PlanFeature> Features { get; } = BuildFeatures();
    public static IReadOnlyCollection<PlanLimit> Limits { get; } = BuildLimits();

    private static IReadOnlyCollection<PlanFeature> BuildFeatures()
    {
        var definitions = new Dictionary<Guid, IReadOnlyCollection<Feature>>
        {
            [FreePlanId] = [Feature.AccessControl, Feature.Attendance, Feature.Work, Feature.Audit],
            [StarterPlanId] = [Feature.AccessControl, Feature.Attendance, Feature.Work, Feature.Messaging, Feature.Files, Feature.Audit],
            [BusinessPlanId] = Enum.GetValues<Feature>(),
            [EnterprisePlanId] = Enum.GetValues<Feature>(),
        };

        return definitions.SelectMany(item => Enum.GetValues<Feature>().Select(feature => new PlanFeature
        {
            Id = StableId($"plan-feature:{item.Key:N}:{feature}"),
            PlanId = item.Key,
            Feature = feature,
            IsEnabled = item.Value.Contains(feature),
            CreatedAtUtc = SeedDateUtc,
            UpdatedAtUtc = SeedDateUtc
        })).ToArray();
    }

    private static IReadOnlyCollection<PlanLimit> BuildLimits()
    {
        var values = new Dictionary<Guid, Dictionary<LimitType, long>>
        {
            [FreePlanId] = new() { [LimitType.MaxEmployees] = 5, [LimitType.MaxLocations] = 1, [LimitType.MaxDoors] = 2, [LimitType.MaxActiveCredentials] = 5, [LimitType.StorageBytes] = 100L * 1024 * 1024, [LimitType.AuditRetentionDays] = 30 },
            [StarterPlanId] = new() { [LimitType.MaxEmployees] = 25, [LimitType.MaxLocations] = 1, [LimitType.MaxDoors] = 10, [LimitType.MaxActiveCredentials] = 50, [LimitType.StorageBytes] = 5L * 1024 * 1024 * 1024, [LimitType.AuditRetentionDays] = 90 },
            [BusinessPlanId] = new() { [LimitType.MaxEmployees] = 250, [LimitType.MaxLocations] = 5, [LimitType.MaxDoors] = 100, [LimitType.MaxActiveCredentials] = 500, [LimitType.StorageBytes] = 50L * 1024 * 1024 * 1024, [LimitType.AuditRetentionDays] = 365 },
            [EnterprisePlanId] = new() { [LimitType.MaxEmployees] = -1, [LimitType.MaxLocations] = -1, [LimitType.MaxDoors] = -1, [LimitType.MaxActiveCredentials] = -1, [LimitType.StorageBytes] = -1, [LimitType.AuditRetentionDays] = 3650 },
        };

        return values.SelectMany(item => item.Value.Select(limit => new PlanLimit
        {
            Id = StableId($"plan-limit:{item.Key:N}:{limit.Key}"),
            PlanId = item.Key,
            Limit = limit.Key,
            Value = limit.Value,
            CreatedAtUtc = SeedDateUtc,
            UpdatedAtUtc = SeedDateUtc
        })).ToArray();
    }

    private static Guid StableId(string value)
    {
        return new Guid(MD5.HashData(Encoding.UTF8.GetBytes(value)));
    }
}
