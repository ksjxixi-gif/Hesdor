using System.Security.Claims;
using Hesdor.Application.Authorization;
using Hesdor.Application.Common;
using Hesdor.Domain.Authorization;
using Hesdor.Domain.Identity;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Authorization;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class M0SecurityTests
{
    [Fact]
    public async Task Tenant_query_filters_return_only_the_current_tenant()
    {
        var tenantA = Guid.NewGuid();
        var tenantB = Guid.NewGuid();
        var databaseName = Guid.NewGuid().ToString();
        var clock = new TestClock();

        await using (var context = CreateContext(databaseName, tenantA, clock))
        {
            context.Departments.Add(new Department { TenantId = tenantA, Name = "Engineering" });
            context.Departments.Add(new Department { TenantId = tenantB, Name = "Finance" });
            await context.SaveChangesAsync();
        }

        await using (var tenantAContext = CreateContext(databaseName, tenantA, clock))
        {
            var departments = await tenantAContext.Departments.ToArrayAsync();
            Assert.Single(departments);
            Assert.Equal("Engineering", departments[0].Name);
        }

        await using (var tenantBContext = CreateContext(databaseName, tenantB, clock))
        {
            var departments = await tenantBContext.Departments.ToArrayAsync();
            Assert.Single(departments);
            Assert.Equal("Finance", departments[0].Name);
        }
    }

    [Fact]
    public async Task Permission_evaluator_applies_role_grants_and_direct_denies()
    {
        var tenantId = Guid.NewGuid();
        var userId = Guid.NewGuid();
        var employeeId = Guid.NewGuid();
        var roleId = Guid.NewGuid();
        var permissionId = Guid.NewGuid();
        var databaseName = Guid.NewGuid().ToString();
        var clock = new TestClock();
        var currentUser = new TestCurrentUser(userId, tenantId);

        await using (var context = CreateContext(databaseName, tenantId, clock, currentUser))
        {
            context.Permissions.Add(new Permission { Id = permissionId, Code = "employees.read", Name = "View employees", Module = "People" });
            context.Users.Add(new User { Id = userId, TenantId = tenantId, EmployeeId = employeeId, Email = "owner@hesdor.test", NormalizedEmail = "OWNER@HESDOR.TEST", PasswordHash = "hash", DisplayName = "Owner" });
            context.Employees.Add(new Employee { Id = employeeId, TenantId = tenantId, EmployeeNumber = "EMP-1", FirstName = "Owner", LastName = "One", JobTitle = "Owner" });
            context.Roles.Add(new Role { Id = roleId, TenantId = tenantId, Name = "Manager" });
            context.EmployeeRoles.Add(new EmployeeRole { TenantId = tenantId, EmployeeId = employeeId, RoleId = roleId, IsPrimary = true });
            context.RolePermissions.Add(new RolePermission { TenantId = tenantId, RoleId = roleId, PermissionId = permissionId, IsAllowed = true });
            await context.SaveChangesAsync();

            var evaluator = new PermissionEvaluator(context, currentUser, new TestTenantContext(tenantId), clock);
            Assert.True(await evaluator.HasPermissionAsync("employees.read"));

            context.EmployeePermissions.Add(new EmployeePermission { TenantId = tenantId, EmployeeId = employeeId, PermissionId = permissionId, IsAllowed = false });
            await context.SaveChangesAsync();
            Assert.False(await evaluator.HasPermissionAsync("employees.read"));
        }
    }

    [Fact]
    public async Task Permission_authorization_handler_succeeds_only_when_evaluator_grants()
    {
        var requirement = new PermissionRequirement("access.door.unlock_remote");
        var principal = new ClaimsPrincipal(new ClaimsIdentity("Bearer"));
        var authorizationContext = new AuthorizationHandlerContext(new[] { requirement }, principal, null);
        var evaluator = new TestPermissionEvaluator("access.door.unlock_remote");
        var handler = new PermissionAuthorizationHandler(evaluator);

        await handler.HandleAsync(authorizationContext);

        Assert.True(authorizationContext.HasSucceeded);
    }

    [Fact]
    public void Access_hierarchy_foreign_keys_include_tenant_id()
    {
        using var context = CreateContext(Guid.NewGuid().ToString(), Guid.NewGuid(), new TestClock());
        var door = context.Model.FindEntityType(typeof(Domain.Access.Door));
        var hierarchyForeignKey = door!.GetForeignKeys().Single(foreignKey => foreignKey.PrincipalEntityType.ClrType == typeof(Domain.Access.Zone));

        Assert.Equal(new[] { "TenantId", "ZoneId" }, hierarchyForeignKey.Properties.Select(property => property.Name));
        Assert.Equal(new[] { "TenantId", "Id" }, hierarchyForeignKey.PrincipalKey.Properties.Select(property => property.Name));
    }

    private static ApplicationDbContext CreateContext(
        string databaseName,
        Guid tenantId,
        TestClock clock,
        TestCurrentUser? currentUser = null)
    {
        var user = currentUser ?? new TestCurrentUser(null, tenantId);
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase(databaseName)
            .Options;
        return new ApplicationDbContext(options, user, new TestTenantContext(tenantId), clock);
    }

    private sealed class TestClock : IDateTimeProvider
    {
        public DateTime UtcNow { get; } = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => TenantId != Guid.Empty;
    }

    private sealed class TestCurrentUser(Guid? userId, Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => UserId is not null;
        public Guid? UserId { get; } = userId;
        public Guid TenantId { get; } = tenantId;
        public string? Email => "test@hesdor.local";
        public IReadOnlyCollection<string> Roles => Array.Empty<string>();
        public bool HasPermission(string permission) => false;
    }

    private sealed class TestPermissionEvaluator(string grantedPermission) : IPermissionEvaluator
    {
        public Task<bool> HasPermissionAsync(string permission, CancellationToken cancellationToken = default) => Task.FromResult(string.Equals(permission, grantedPermission, StringComparison.OrdinalIgnoreCase));

        public Task<IReadOnlyCollection<string>> GetPermissionsAsync(CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyCollection<string>>([grantedPermission]);
    }
}
