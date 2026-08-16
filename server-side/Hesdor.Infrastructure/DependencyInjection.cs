using Hesdor.Infrastructure.Authentication;
using Hesdor.Infrastructure.Audit;
using Hesdor.Infrastructure.Access;
using Hesdor.Infrastructure.Authorization;
using Hesdor.Infrastructure.Common;
using Hesdor.Infrastructure.MultiTenancy;
using Hesdor.Infrastructure.Edge;
using Hesdor.Infrastructure.Attendance;
using Hesdor.Infrastructure.Work;
using Hesdor.Infrastructure.Messaging;
using Hesdor.Infrastructure.Billing;
using Microsoft.AspNetCore.Authorization;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;

namespace Hesdor.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddHesdorInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("Postgres");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("ConnectionStrings:Postgres is required.");
        }

        services.AddHttpContextAccessor();
        services.AddScoped<ICurrentUserService, CurrentUserService>();
        services.AddScoped<ITenantContext, TenantContext>();
        services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();
        services.AddScoped<IPasswordHasher<User>, PasswordHasher<User>>();
        services.AddScoped<ITokenService, JwtTokenService>();
        services.AddScoped<IAuthenticationService, AuthenticationService>();
        services.AddScoped<IPermissionEvaluator, PermissionEvaluator>();
        services.AddScoped<IAccessPolicyEvaluator, AccessPolicyEvaluator>();
        services.AddScoped<IAttendanceService, AttendanceService>();
        services.AddScoped<IWorkService, WorkService>();
        services.AddScoped<IMessagingService, MessagingService>();
        services.AddScoped<IEntitlementService, EntitlementService>();
        services.AddScoped<IBillingService, BillingService>();
        services.AddSingleton<IPaymentProvider, ManualPaymentProvider>();
        services.AddSingleton<IAccessControllerAdapter, HesdorNativeAccessControllerAdapter>();
        services.AddSingleton<IEdgeCredentialService, EdgeCredentialService>();
        services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
        services.AddScoped<IAuthorizationHandler, PermissionAuthorizationHandler>();
        services.AddScoped<IAuditWriter, AuditWriter>();
        services.AddDbContext<ApplicationDbContext>(options => options.UseNpgsql(connectionString));

        return services;
    }
}
