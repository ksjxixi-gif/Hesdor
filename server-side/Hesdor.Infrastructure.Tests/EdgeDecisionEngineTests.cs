using Hesdor.EdgeAgent;

namespace Hesdor.Infrastructure.Tests;

public sealed class EdgeDecisionEngineTests
{
    private static readonly Guid DoorId = Guid.NewGuid();
    private static readonly Guid ZoneId = Guid.NewGuid();
    private static readonly Guid EmployeeId = Guid.NewGuid();
    private static readonly Guid CredentialId = Guid.NewGuid();
    private static readonly Guid ProfileId = Guid.NewGuid();

    private static SyncResponse Snapshot(Action<SyncResponse>? mutate = null)
    {
        var snapshot = new SyncResponse
        {
            Credentials = [new SyncCredential { Id = CredentialId, EmployeeId = EmployeeId, PublicIdentifier = "CARD-1", Status = CredentialStatus.Active }],
            Doors = [new SyncDoor { Id = DoorId, ZoneId = ZoneId, Name = "Main", Status = DoorStatus.Active }],
            Employees = [new SyncEmployee { Id = EmployeeId, EmploymentStatus = EmployeeStatus.Active }],
            EmployeeProfiles = [new SyncEmployeeProfile { EmployeeId = EmployeeId, AccessProfileId = ProfileId }],
            Rules = [new SyncRule { AccessProfileId = ProfileId, ZoneId = ZoneId, DaysOfWeekMask = 127, StartTimeUtc = new TimeSpan(9, 0, 0), EndTimeUtc = new TimeSpan(17, 0, 0), IsAllowed = true }]
        };
        mutate?.Invoke(snapshot);
        return snapshot;
    }

    [Fact]
    public void GrantsWithinSchedule()
    {
        var (decision, reason) = new AccessDecisionEngine(Snapshot()).Evaluate("CARD-1", DoorId, TuesdayAt(12, 0));
        Assert.Equal(Decision.Granted, decision);
        Assert.Equal("access_rule_granted", reason);
    }

    [Fact]
    public void DeniesOutsideSchedule()
    {
        var (decision, _) = new AccessDecisionEngine(Snapshot()).Evaluate("CARD-1", DoorId, TuesdayAt(22, 0));
        Assert.Equal(Decision.OutsideSchedule, decision);
    }

    [Fact]
    public void OvernightWindowCrossesMidnight()
    {
        var snapshot = Snapshot(s => s.Rules[0].StartTimeUtc = new TimeSpan(22, 0, 0));
        snapshot.Rules[0].EndTimeUtc = new TimeSpan(4, 0, 0);
        var engine = new AccessDecisionEngine(snapshot);
        Assert.Equal(Decision.Granted, engine.Evaluate("CARD-1", DoorId, TuesdayAt(23, 0)).Decision);
        Assert.Equal(Decision.Granted, engine.Evaluate("CARD-1", DoorId, TuesdayAt(3, 0)).Decision);
    }

    [Fact]
    public void UnknownCredentialFailsClosed()
    {
        var (decision, _) = new AccessDecisionEngine(Snapshot()).Evaluate("NOPE", DoorId, TuesdayAt(12, 0));
        Assert.Equal(Decision.UnknownCredential, decision);
    }

    [Fact]
    public void SuspendedCredentialIsRejected()
    {
        var snapshot = Snapshot(s => s.Credentials[0].Status = 1);
        Assert.Equal(Decision.ExpiredCredential, new AccessDecisionEngine(snapshot).Evaluate("CARD-1", DoorId, TuesdayAt(12, 0)).Decision);
    }

    [Fact]
    public void TemporaryGrantOverridesSchedule()
    {
        var snapshot = Snapshot(s => s.TemporaryGrants = [new SyncTemporaryGrant { EmployeeId = EmployeeId, ValidFromUtc = TuesdayAt(0, 0), ValidToUtc = TuesdayAt(23, 59, 59) }]);
        var (decision, reason) = new AccessDecisionEngine(snapshot).Evaluate("CARD-1", DoorId, TuesdayAt(22, 0));
        Assert.Equal(Decision.TemporaryGrant, decision);
        Assert.Equal("temporary_grant", reason);
    }

    private static DateTime TuesdayAt(int hour, int minute, int second = 0)
    {
        var date = new DateTime(2026, 8, 18, hour, minute, second, DateTimeKind.Utc); // a Tuesday
        return date;
    }
}
