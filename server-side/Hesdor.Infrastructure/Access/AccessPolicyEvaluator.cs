using Hesdor.Application.Access;
using Hesdor.Domain.Access;
using Hesdor.Domain.People;
using Hesdor.Infrastructure.Persistence;

namespace Hesdor.Infrastructure.Access;

public sealed class AccessPolicyEvaluator : IAccessPolicyEvaluator
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ITenantContext _tenantContext;
    private readonly IDateTimeProvider _dateTimeProvider;

    public AccessPolicyEvaluator(
        ApplicationDbContext dbContext,
        ITenantContext tenantContext,
        IDateTimeProvider dateTimeProvider)
    {
        _dbContext = dbContext;
        _tenantContext = tenantContext;
        _dateTimeProvider = dateTimeProvider;
    }

    public async Task<AccessDecisionResult> EvaluateAsync(
        AccessDecisionRequest request,
        CancellationToken cancellationToken = default)
    {
        var evaluatedAt = _dateTimeProvider.UtcNow;
        if (!_tenantContext.HasTenant)
        {
            return Denied(request, AccessDecision.Denied, "tenant_context_required", evaluatedAt);
        }

        var credential = await _dbContext.Credentials
            .SingleOrDefaultAsync(entity => entity.PublicIdentifier == request.CredentialIdentifier, cancellationToken);
        if (credential is null)
        {
            return Denied(request, AccessDecision.UnknownCredential, "credential_not_found", evaluatedAt);
        }

        if (credential.Status != CredentialStatus.Active || credential.RevokedAtUtc is not null || credential.ExpiresAtUtc <= request.OccurredAtUtc)
        {
            return Denied(request, AccessDecision.ExpiredCredential, "credential_inactive_or_expired", evaluatedAt, credential.Id, credential.EmployeeId);
        }

        if (credential.EmployeeId is not Guid employeeId)
        {
            return Denied(request, AccessDecision.Denied, "credential_has_no_employee", evaluatedAt, credential.Id);
        }

        var employee = await _dbContext.Employees.SingleOrDefaultAsync(entity => entity.Id == employeeId, cancellationToken);
        if (employee is null || employee.EmploymentStatus != EmploymentStatus.Active)
        {
            return Denied(request, AccessDecision.EmployeeInactive, "employee_inactive", evaluatedAt, credential.Id, employeeId);
        }

        var door = await _dbContext.Doors.SingleOrDefaultAsync(entity => entity.Id == request.DoorId, cancellationToken);
        if (door is null)
        {
            return Denied(request, AccessDecision.Denied, "door_not_found", evaluatedAt, credential.Id, employeeId);
        }

        if (door.Status != DoorStatus.Active)
        {
            return Denied(request, AccessDecision.DeviceOffline, "door_unavailable", evaluatedAt, credential.Id, employeeId);
        }

        var temporaryGrant = await _dbContext.TemporaryAccessGrants
            .Where(grant => grant.EmployeeId == employeeId && !grant.IsRevoked)
            .Where(grant => grant.ValidFromUtc <= request.OccurredAtUtc && grant.ValidToUtc > request.OccurredAtUtc)
            .Where(grant => grant.DoorId == door.Id || grant.DoorId == null)
            .Where(grant => grant.ZoneId == door.ZoneId || grant.ZoneId == null)
            .OrderByDescending(grant => grant.ValidFromUtc)
            .FirstOrDefaultAsync(cancellationToken);
        if (temporaryGrant is not null)
        {
            return new AccessDecisionResult(true, AccessDecision.TemporaryGrant, "temporary_grant", credential.Id, employeeId, door.Id, evaluatedAt);
        }

        var profileIds = await _dbContext.EmployeeAccessProfiles
            .Where(assignment => assignment.EmployeeId == employeeId)
            .Where(assignment => assignment.ValidFromUtc == null || assignment.ValidFromUtc <= request.OccurredAtUtc)
            .Where(assignment => assignment.ValidToUtc == null || assignment.ValidToUtc > request.OccurredAtUtc)
            .Select(assignment => assignment.AccessProfileId)
            .ToArrayAsync(cancellationToken);
        if (profileIds.Length == 0)
        {
            return Denied(request, AccessDecision.Denied, "access_profile_not_assigned", evaluatedAt, credential.Id, employeeId);
        }

        var rules = await _dbContext.AccessRules
            .Where(rule => profileIds.Contains(rule.AccessProfileId))
            .Where(rule => rule.DoorId == door.Id || rule.ZoneId == door.ZoneId)
            .Where(rule => rule.ValidFromUtc == null || rule.ValidFromUtc <= request.OccurredAtUtc)
            .Where(rule => rule.ValidToUtc == null || rule.ValidToUtc > request.OccurredAtUtc)
            .OrderByDescending(rule => rule.Priority)
            .ToArrayAsync(cancellationToken);

        var dayMask = 1 << (int)request.OccurredAtUtc.DayOfWeek;
        var time = request.OccurredAtUtc.TimeOfDay;
        var matchingRule = rules.FirstOrDefault(rule =>
            (rule.DaysOfWeekMask & dayMask) != 0 &&
            IsWithinWindow(time, rule.StartTimeUtc, rule.EndTimeUtc));

        if (matchingRule is null)
        {
            return Denied(request, AccessDecision.OutsideSchedule, "outside_access_schedule", evaluatedAt, credential.Id, employeeId);
        }

        return matchingRule.IsAllowed
            ? new AccessDecisionResult(true, AccessDecision.Granted, "access_rule_granted", credential.Id, employeeId, door.Id, evaluatedAt)
            : Denied(request, AccessDecision.Denied, "access_rule_denied", evaluatedAt, credential.Id, employeeId);
    }

    private static bool IsWithinWindow(TimeSpan time, TimeSpan start, TimeSpan end)
    {
        return start <= end ? time >= start && time <= end : time >= start || time <= end;
    }

    private static AccessDecisionResult Denied(
        AccessDecisionRequest request,
        AccessDecision decision,
        string reason,
        DateTime evaluatedAt,
        Guid? credentialId = null,
        Guid? employeeId = null)
    {
        return new AccessDecisionResult(false, decision, reason, credentialId, employeeId, request.DoorId, evaluatedAt);
    }
}
