namespace Hesdor.EdgeAgent;

/// <summary>
/// Offline evaluation against the last synced snapshot. Mirrors the server's AccessPolicyEvaluator decisions
/// so door behavior is identical whether the server is reachable or not.
/// </summary>
public sealed class AccessDecisionEngine(SyncResponse snapshot)
{
    public (int Decision, string Reason) Evaluate(string credentialIdentifier, Guid doorId, DateTime occurredAtUtc)
    {
        var credential = snapshot.Credentials.FirstOrDefault(c => string.Equals(c.PublicIdentifier, credentialIdentifier, StringComparison.OrdinalIgnoreCase));
        if (credential is null)
        {
            return (Decision.UnknownCredential, "credential_not_found");
        }

        if (credential.Status != CredentialStatus.Active || credential.RevokedAtUtc is not null || (credential.ExpiresAtUtc is { } expires && expires <= occurredAtUtc))
        {
            return (Decision.ExpiredCredential, "credential_inactive_or_expired");
        }

        if (credential.EmployeeId is not Guid employeeId)
        {
            return (Decision.Denied, "credential_has_no_employee");
        }

        var employee = snapshot.Employees.FirstOrDefault(e => e.Id == employeeId);
        if (employee is null || employee.EmploymentStatus != EmployeeStatus.Active)
        {
            return (Decision.EmployeeInactive, "employee_inactive");
        }

        var door = snapshot.Doors.FirstOrDefault(d => d.Id == doorId);
        if (door is null)
        {
            return (Decision.Denied, "door_not_found");
        }

        if (door.Status != DoorStatus.Active)
        {
            return (Decision.DeviceOffline, "door_unavailable");
        }

        var grant = snapshot.TemporaryGrants
            .Where(g => g.EmployeeId == employeeId && g.ValidFromUtc <= occurredAtUtc && g.ValidToUtc > occurredAtUtc)
            .Where(g => g.DoorId == door.Id || g.DoorId is null)
            .Where(g => g.ZoneId == door.ZoneId || g.ZoneId is null)
            .OrderByDescending(g => g.ValidFromUtc)
            .FirstOrDefault();
        if (grant is not null)
        {
            return (Decision.TemporaryGrant, "temporary_grant");
        }

        var profileIds = snapshot.EmployeeProfiles
            .Where(p => p.EmployeeId == employeeId)
            .Where(p => p.ValidFromUtc is null || p.ValidFromUtc <= occurredAtUtc)
            .Where(p => p.ValidToUtc is null || p.ValidToUtc > occurredAtUtc)
            .Select(p => p.AccessProfileId)
            .ToArray();
        if (profileIds.Length == 0)
        {
            return (Decision.Denied, "access_profile_not_assigned");
        }

        var rules = snapshot.Rules
            .Where(rule => profileIds.Contains(rule.AccessProfileId))
            .Where(rule => rule.DoorId == door.Id || rule.ZoneId == door.ZoneId)
            .Where(rule => rule.ValidFromUtc is null || rule.ValidFromUtc <= occurredAtUtc)
            .Where(rule => rule.ValidToUtc is null || rule.ValidToUtc > occurredAtUtc)
            .OrderByDescending(rule => rule.Priority)
            .ToArray();

        var dayMask = 1 << (int)occurredAtUtc.DayOfWeek;
        var time = occurredAtUtc.TimeOfDay;
        var matchingRule = rules.FirstOrDefault(rule =>
            (rule.DaysOfWeekMask & dayMask) != 0 &&
            IsWithinWindow(time, rule.StartTimeUtc, rule.EndTimeUtc));

        if (matchingRule is null)
        {
            return (Decision.OutsideSchedule, "outside_access_schedule");
        }

        return matchingRule.IsAllowed
            ? (Decision.Granted, "access_rule_granted")
            : (Decision.Denied, "access_rule_denied");
    }

    // Matches the server's overnight-window semantics (e.g. 22:00 -> 04:00).
    private static bool IsWithinWindow(TimeSpan time, TimeSpan start, TimeSpan end)
    {
        return start <= end ? time >= start && time <= end : time >= start || time <= end;
    }
}
