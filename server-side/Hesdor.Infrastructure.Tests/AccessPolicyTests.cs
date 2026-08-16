using Hesdor.Application.Access;
using Hesdor.Application.Common;
using Hesdor.Domain.Access;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Access;
using Hesdor.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class AccessPolicyTests
{
    [Fact]
    public async Task Active_credential_and_matching_rule_are_granted()
    {
        var fixture = await AccessFixture.CreateAsync(includeRule: true);

        var result = await fixture.Evaluator.EvaluateAsync(fixture.Request);

        Assert.True(result.IsAllowed);
        Assert.Equal(AccessDecision.Granted, result.Decision);
    }

    [Fact]
    public async Task Expired_credential_is_denied_before_policy_lookup()
    {
        var fixture = await AccessFixture.CreateAsync(includeRule: true, credentialExpiresAtUtc: new DateTime(2025, 12, 31, 23, 59, 0, DateTimeKind.Utc));

        var result = await fixture.Evaluator.EvaluateAsync(fixture.Request);

        Assert.False(result.IsAllowed);
        Assert.Equal(AccessDecision.ExpiredCredential, result.Decision);
    }

    [Fact]
    public async Task Terminated_employee_cannot_open_a_door()
    {
        var fixture = await AccessFixture.CreateAsync(includeRule: true, employmentStatus: EmploymentStatus.Terminated);

        var result = await fixture.Evaluator.EvaluateAsync(fixture.Request);

        Assert.False(result.IsAllowed);
        Assert.Equal(AccessDecision.EmployeeInactive, result.Decision);
    }

    [Fact]
    public async Task Active_temporary_grant_can_allow_without_a_profile_rule()
    {
        var fixture = await AccessFixture.CreateAsync(includeRule: false, includeTemporaryGrant: true);

        var result = await fixture.Evaluator.EvaluateAsync(fixture.Request);

        Assert.True(result.IsAllowed);
        Assert.Equal(AccessDecision.TemporaryGrant, result.Decision);
    }

    private sealed class AccessFixture
    {
        private AccessFixture(ApplicationDbContext context, AccessPolicyEvaluator evaluator, AccessDecisionRequest request)
        {
            Context = context;
            Evaluator = evaluator;
            Request = request;
        }

        public ApplicationDbContext Context { get; }
        public AccessPolicyEvaluator Evaluator { get; }
        public AccessDecisionRequest Request { get; }

        public static async Task<AccessFixture> CreateAsync(
            bool includeRule,
            bool includeTemporaryGrant = false,
            DateTime? credentialExpiresAtUtc = null,
            EmploymentStatus employmentStatus = EmploymentStatus.Active)
        {
            var tenantId = Guid.NewGuid();
            var employeeId = Guid.NewGuid();
            var credentialId = Guid.NewGuid();
            var doorId = Guid.NewGuid();
            var zoneId = Guid.NewGuid();
            var profileId = Guid.NewGuid();
            var now = new DateTime(2026, 1, 5, 10, 0, 0, DateTimeKind.Utc);
            var options = new DbContextOptionsBuilder<ApplicationDbContext>()
                .UseInMemoryDatabase(Guid.NewGuid().ToString())
                .Options;
            var currentUser = new TestCurrentUser(tenantId);
            var tenantContext = new TestTenantContext(tenantId);
            var clock = new TestClock(now);
            var context = new ApplicationDbContext(options, currentUser, tenantContext, clock);

            context.Employees.Add(new Employee
            {
                Id = employeeId,
                TenantId = tenantId,
                FirstName = "Ada",
                LastName = "Lovelace",
                EmployeeNumber = "EMP-1",
                JobTitle = "Engineer",
                EmploymentStatus = employmentStatus
            });
            context.Credentials.Add(new Credential
            {
                Id = credentialId,
                TenantId = tenantId,
                EmployeeId = employeeId,
                PublicIdentifier = "credential-1",
                IssuedAtUtc = now.AddDays(-1),
                ExpiresAtUtc = credentialExpiresAtUtc ?? now.AddDays(1)
            });
            context.Zones.Add(new Zone { Id = zoneId, TenantId = tenantId, FloorId = Guid.NewGuid(), Name = "Engineering", Code = "ENG" });
            context.Doors.Add(new Door { Id = doorId, TenantId = tenantId, ZoneId = zoneId, Name = "Main Door", Code = "MAIN" });

            if (includeRule)
            {
                context.AccessProfiles.Add(new AccessProfile { Id = profileId, TenantId = tenantId, Name = "Standard" });
                context.EmployeeAccessProfiles.Add(new EmployeeAccessProfile { TenantId = tenantId, EmployeeId = employeeId, AccessProfileId = profileId, ValidFromUtc = now.AddDays(-1) });
                context.AccessRules.Add(new AccessRule
                {
                    TenantId = tenantId,
                    AccessProfileId = profileId,
                    DoorId = doorId,
                    DaysOfWeekMask = 1 << (int)now.DayOfWeek,
                    StartTimeUtc = new TimeSpan(9, 0, 0),
                    EndTimeUtc = new TimeSpan(17, 0, 0),
                    IsAllowed = true
                });
            }

            if (includeTemporaryGrant)
            {
                context.TemporaryAccessGrants.Add(new TemporaryAccessGrant
                {
                    TenantId = tenantId,
                    EmployeeId = employeeId,
                    DoorId = doorId,
                    ValidFromUtc = now.AddMinutes(-5),
                    ValidToUtc = now.AddMinutes(5),
                    Reason = "Test grant"
                });
            }

            await context.SaveChangesAsync();
            return new AccessFixture(context, new AccessPolicyEvaluator(context, tenantContext, clock), new AccessDecisionRequest("credential-1", doorId, now));
        }
    }

    private sealed class TestClock(DateTime now) : IDateTimeProvider
    {
        public DateTime UtcNow { get; } = now;
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => TenantId != Guid.Empty;
    }

    private sealed class TestCurrentUser(Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => false;
        public Guid? UserId => null;
        public Guid TenantId { get; } = tenantId;
        public string? Email => null;
        public IReadOnlyCollection<string> Roles => Array.Empty<string>();
        public bool HasPermission(string permission) => false;
    }
}
