using Hesdor.Application.Audit;
using Hesdor.Application.Identity;
using Hesdor.Domain.Audit;
using Hesdor.Domain.Authorization;
using Hesdor.Domain.Identity;
using Hesdor.Domain.Organizations;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;

namespace Hesdor.Infrastructure.Authentication;

public sealed class AuthenticationService : IAuthenticationService
{
    private readonly ApplicationDbContext _dbContext;
    private readonly IPasswordHasher<User> _passwordHasher;
    private readonly ITokenService _tokenService;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly IAuditWriter _auditWriter;
    private readonly IHttpContextAccessor _httpContextAccessor;

    public AuthenticationService(
        ApplicationDbContext dbContext,
        IPasswordHasher<User> passwordHasher,
        ITokenService tokenService,
        IDateTimeProvider dateTimeProvider,
        IAuditWriter auditWriter,
        IHttpContextAccessor httpContextAccessor)
    {
        _dbContext = dbContext;
        _passwordHasher = passwordHasher;
        _tokenService = tokenService;
        _dateTimeProvider = dateTimeProvider;
        _auditWriter = auditWriter;
        _httpContextAccessor = httpContextAccessor;
    }

    public async Task<AuthenticationResult> BootstrapAsync(
        BootstrapRequest request,
        CancellationToken cancellationToken = default)
    {
        if (await _dbContext.Tenants.IgnoreQueryFilters().AnyAsync(cancellationToken))
        {
            return new AuthenticationResult(false, FailureReason: "Initial organization setup is already complete.");
        }

        var email = request.Email.Trim();
        var organizationName = request.OrganizationName.Trim();
        var displayName = request.DisplayName.Trim();
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(organizationName) || string.IsNullOrWhiteSpace(displayName) || request.Password.Length < 8)
        {
            return new AuthenticationResult(false, FailureReason: "Organization, display name, email, and an eight-character password are required.");
        }

        var now = _dateTimeProvider.UtcNow;
        var tenant = new Tenant
        {
            Name = organizationName,
            Slug = CreateSlug(request.Slug ?? organizationName),
            Plan = TenantPlan.Free,
            PlanId = PlanCatalog.FreePlanId,
            Status = TenantStatus.Active,
            TrialEndsAtUtc = now.AddDays(14),
            Locale = "en-US",
            TimeZone = "UTC"
        };
        var user = new User
        {
            TenantId = tenant.Id,
            Email = email,
            NormalizedEmail = NormalizeEmail(email),
            DisplayName = displayName,
            Status = UserStatus.Active
        };
        user.PasswordHash = _passwordHasher.HashPassword(user, request.Password);

        var employee = new Employee
        {
            TenantId = tenant.Id,
            UserId = user.Id,
            Email = email,
            FirstName = displayName.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? displayName,
            LastName = displayName.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).LastOrDefault() ?? "Owner",
            EmployeeNumber = "EMP-0001",
            JobTitle = "Owner",
            EmploymentStatus = EmploymentStatus.Active,
            EmploymentType = EmploymentType.FullTime,
            HiredAtUtc = now
        };
        user.EmployeeId = employee.Id;

        var ownerRole = new Role
        {
            TenantId = tenant.Id,
            Name = "Owner",
            Description = "Initial organization owner role.",
            IsSystemRole = true,
            SortOrder = 0
        };
        tenant.OwnerUserId = user.Id;

        _dbContext.Tenants.Add(tenant);
        _dbContext.Users.Add(user);
        _dbContext.Employees.Add(employee);
        _dbContext.Roles.Add(ownerRole);
        _dbContext.EmployeeRoles.Add(new EmployeeRole
        {
            TenantId = tenant.Id,
            EmployeeId = employee.Id,
            RoleId = ownerRole.Id,
            IsPrimary = true,
            ValidFromUtc = now
        });

        var permissions = await EnsurePermissionCatalogAsync(cancellationToken);
        _dbContext.RolePermissions.AddRange(permissions.Select(permission => new RolePermission
        {
            TenantId = tenant.Id,
            RoleId = ownerRole.Id,
            PermissionId = permission.Id,
            IsAllowed = true
        }));

        _dbContext.Subscriptions.Add(new Subscription
        {
            TenantId = tenant.Id,
            PlanId = PlanCatalog.FreePlanId,
            Status = SubscriptionStatus.Trialing,
            BillingCycle = BillingCycle.Monthly,
            Provider = BillingProvider.Manual,
            StartedAtUtc = now,
            CurrentPeriodStartUtc = now,
            CurrentPeriodEndUtc = now.AddDays(14),
            TrialEndsAtUtc = now.AddDays(14)
        });
        _dbContext.TenantTrials.Add(new TenantTrial
        {
            TenantId = tenant.Id,
            StartedAtUtc = now,
            EndsAtUtc = now.AddDays(14)
        });

        var token = IssueAndStoreTokens(user, [ownerRole.Name]);
        await _auditWriter.RecordAsync(
            new AuditEventInput(tenant.Id, "tenant.bootstrap_completed", nameof(Tenant), tenant.Id.ToString(), Severity: AuditSeverity.Info),
            cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);

        return new AuthenticationResult(true, token);
    }

    public async Task<AuthenticationResult> AuthenticateAsync(
        AuthenticationRequest request,
        CancellationToken cancellationToken = default)
    {
        var email = request.Email.Trim();
        var user = await _dbContext.Users
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(entity => entity.NormalizedEmail == NormalizeEmail(email), cancellationToken);

        if (user is null)
        {
            return new AuthenticationResult(false, FailureReason: "Invalid credentials.");
        }

        var now = _dateTimeProvider.UtcNow;
        if (user.Status != UserStatus.Active || user.LockedUntilUtc is not null && user.LockedUntilUtc > now)
        {
            return new AuthenticationResult(false, FailureReason: "Account is unavailable.");
        }

        var passwordResult = _passwordHasher.VerifyHashedPassword(user, user.PasswordHash, request.Password);
        if (passwordResult == PasswordVerificationResult.Failed)
        {
            user.FailedLoginAttempts++;
            if (user.FailedLoginAttempts >= 5)
            {
                user.LockedUntilUtc = now.AddMinutes(15);
            }

            await _auditWriter.RecordAsync(new AuditEventInput(user.TenantId, "auth.login_failed", nameof(User), user.Id.ToString(), Severity: AuditSeverity.Warning), cancellationToken);
            await _dbContext.SaveChangesAsync(cancellationToken);
            return new AuthenticationResult(false, FailureReason: "Invalid credentials.");
        }

        var tenant = await _dbContext.Tenants.AsNoTracking().SingleOrDefaultAsync(entity => entity.Id == user.TenantId, cancellationToken);
        if (tenant is null || tenant.Status is TenantStatus.Suspended or TenantStatus.Terminated)
        {
            return new AuthenticationResult(false, FailureReason: "Organization is unavailable.");
        }

        var roles = await GetRoleNamesAsync(user, now, cancellationToken);
        user.LastLoginAtUtc = now;
        user.FailedLoginAttempts = 0;
        user.LockedUntilUtc = null;
        if (passwordResult == PasswordVerificationResult.SuccessRehashNeeded)
        {
            user.PasswordHash = _passwordHasher.HashPassword(user, request.Password);
        }

        var token = IssueAndStoreTokens(user, roles);
        await _auditWriter.RecordAsync(new AuditEventInput(user.TenantId, "auth.login_succeeded", nameof(User), user.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return new AuthenticationResult(true, token);
    }

    public async Task<AuthenticationResult> RefreshAsync(
        RefreshTokenRequest request,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(request.RefreshToken))
        {
            return new AuthenticationResult(false, FailureReason: "Refresh token is required.");
        }

        var now = _dateTimeProvider.UtcNow;
        var tokenHash = _tokenService.HashRefreshToken(request.RefreshToken);
        var storedToken = await _dbContext.RefreshTokens
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(entity => entity.TokenHash == tokenHash, cancellationToken);

        if (storedToken is null || storedToken.RevokedAtUtc is not null || storedToken.ExpiresAtUtc <= now)
        {
            return new AuthenticationResult(false, FailureReason: "Refresh token is invalid or expired.");
        }

        var user = await _dbContext.Users
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(entity => entity.Id == storedToken.UserId && entity.TenantId == storedToken.TenantId, cancellationToken);
        if (user is null || user.Status != UserStatus.Active)
        {
            return new AuthenticationResult(false, FailureReason: "Account is unavailable.");
        }

        var roles = await GetRoleNamesAsync(user, now, cancellationToken);
        var token = IssueAndStoreTokens(user, roles);
        storedToken.RevokedAtUtc = now;
        storedToken.RevokedByIp = GetRemoteIp();
        storedToken.ReplacedByTokenHash = _tokenService.HashRefreshToken(token.RefreshToken);
        await _auditWriter.RecordAsync(new AuditEventInput(user.TenantId, "auth.refresh_succeeded", nameof(User), user.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
        return new AuthenticationResult(true, token);
    }

    public async Task RevokeRefreshTokenAsync(
        RefreshTokenRequest request,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(request.RefreshToken))
        {
            return;
        }

        var tokenHash = _tokenService.HashRefreshToken(request.RefreshToken);
        var storedToken = await _dbContext.RefreshTokens
            .IgnoreQueryFilters()
            .SingleOrDefaultAsync(entity => entity.TokenHash == tokenHash, cancellationToken);
        if (storedToken is null || storedToken.RevokedAtUtc is not null)
        {
            return;
        }

        storedToken.RevokedAtUtc = _dateTimeProvider.UtcNow;
        storedToken.RevokedByIp = GetRemoteIp();
        await _auditWriter.RecordAsync(new AuditEventInput(storedToken.TenantId, "auth.refresh_revoked", nameof(RefreshToken), storedToken.Id.ToString()), cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);
    }

    private async Task<IReadOnlyCollection<Permission>> EnsurePermissionCatalogAsync(CancellationToken cancellationToken)
    {
        var codes = PermissionCatalog.All.Select(permission => permission.Code).ToArray();
        var existing = await _dbContext.Permissions
            .Where(permission => codes.Contains(permission.Code))
            .ToListAsync(cancellationToken);
        var existingCodes = existing.Select(permission => permission.Code).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var missing = PermissionCatalog.All
            .Where(permission => !existingCodes.Contains(permission.Code))
            .Select(permission => new Permission
            {
                Code = permission.Code,
                Name = permission.Name,
                Module = permission.Module,
                Description = permission.Description
            })
            .ToArray();
        _dbContext.Permissions.AddRange(missing);
        return existing.Concat(missing).ToArray();
    }

    private async Task<IReadOnlyCollection<string>> GetRoleNamesAsync(User user, DateTime now, CancellationToken cancellationToken)
    {
        if (user.EmployeeId is not Guid employeeId)
        {
            return Array.Empty<string>();
        }

        return await (
            from employeeRole in _dbContext.EmployeeRoles.IgnoreQueryFilters()
            join role in _dbContext.Roles.IgnoreQueryFilters() on employeeRole.RoleId equals role.Id
            where employeeRole.TenantId == user.TenantId
                && employeeRole.EmployeeId == employeeId
                && !employeeRole.IsDeleted
                && !role.IsDeleted
                && (employeeRole.ValidFromUtc == null || employeeRole.ValidFromUtc <= now)
                && (employeeRole.ValidToUtc == null || employeeRole.ValidToUtc > now)
            select role.Name)
            .Distinct()
            .ToArrayAsync(cancellationToken);
    }

    private TokenResult IssueAndStoreTokens(User user, IReadOnlyCollection<string> roles)
    {
        var token = _tokenService.IssueAccessToken(new IssuedPrincipal(user.Id, user.TenantId, user.Email, roles));
        _dbContext.RefreshTokens.Add(new RefreshToken
        {
            TenantId = user.TenantId,
            UserId = user.Id,
            TokenHash = _tokenService.HashRefreshToken(token.RefreshToken),
            ExpiresAtUtc = token.RefreshTokenExpiresAtUtc,
            CreatedByIp = GetRemoteIp()
        });
        return token;
    }

    private string? GetRemoteIp() => _httpContextAccessor.HttpContext?.Connection.RemoteIpAddress?.ToString();

    private static string NormalizeEmail(string email) => email.Trim().ToUpperInvariant();

    private static string CreateSlug(string value)
    {
        var slug = new string(value
            .Trim()
            .ToLowerInvariant()
            .Select(character => char.IsLetterOrDigit(character) ? character : '-')
            .ToArray());
        while (slug.Contains("--", StringComparison.Ordinal))
        {
            slug = slug.Replace("--", "-", StringComparison.Ordinal);
        }
        return slug.Trim('-');
    }
}
