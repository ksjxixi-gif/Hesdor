using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Hesdor.EdgeAgent;

var serverUrl = args.FirstOrDefault(a => a.StartsWith("--server="))?["--server=".Length..]
    ?? Environment.GetEnvironmentVariable("HESDOR_EDGE_SERVER") ?? "http://localhost:5187";
var edgeKey = args.FirstOrDefault(a => a.StartsWith("--key="))?["--key=".Length..]
    ?? Environment.GetEnvironmentVariable("HESDOR_EDGE_KEY");

if (string.IsNullOrWhiteSpace(edgeKey))
{
    Console.Error.WriteLine("Usage: Hesdor.EdgeAgent --server=<url> --key=<edge-api-key> (or HESDOR_EDGE_SERVER / HESDOR_EDGE_KEY)");
    return 1;
}

var queuePath = Path.Combine(AppContext.BaseDirectory, "edge-queue.json");
var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
var httpClient = new HttpClient { BaseAddress = new Uri(serverUrl.TrimEnd('/') + "/") };
httpClient.DefaultRequestHeaders.Add("X-Hesdor-Edge-Key", edgeKey);

var agentVersion = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.1.0";
var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

var queue = LoadQueue();
var snapshotLock = new object();
SyncResponse? snapshot = null;

_ = Task.Run(() => UploadLoopAsync(cts.Token));
_ = Task.Run(() => HeartbeatLoopAsync(cts.Token));
_ = Task.Run(() => SyncLoopAsync(cts.Token));
await SyncOnceAsync(cts.Token);
_ = ReadLoopAsync(cts.Token);

try { await Task.Delay(Timeout.Infinite, cts.Token); }
catch (OperationCanceledException) { }

SaveQueue();
return 0;

List<EdgeEventPayload> LoadQueue()
{
    try
    {
        if (File.Exists(queuePath))
        {
            return JsonSerializer.Deserialize<List<EdgeEventPayload>>(File.ReadAllText(queuePath), jsonOptions) ?? [];
        }
    }
    catch { /* ponytail: corrupt queue file loses unsent events; SQLite if that ever matters */ }
    return [];
}

void SaveQueue()
{
    lock (queue)
    {
        File.WriteAllText(queuePath, JsonSerializer.Serialize(queue, jsonOptions));
    }
}

async Task SyncOnceAsync(CancellationToken ct)
{
    try
    {
        using var response = await httpClient.PostAsync("api/edge/sync", content: null, ct);
        response.EnsureSuccessStatusCode();
        var synced = await response.Content.ReadFromJsonAsync<SyncResponse>(jsonOptions, ct);
        if (synced is not null)
        {
            lock (snapshotLock)
            {
                snapshot = synced;
            }
            Console.WriteLine($"[{DateTime.UtcNow:HH:mm:ss}] synced config v{synced.ConfigVersion}: {synced.Credentials.Count} credentials, {synced.Doors.Count} doors, {synced.Rules.Count} rules");
        }
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        Console.WriteLine($"[{DateTime.UtcNow:HH:mm:ss}] sync failed: {ex.Message}");
    }
}

async Task SyncLoopAsync(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromMinutes(1), ct);
        await SyncOnceAsync(ct);
    }
}

async Task HeartbeatLoopAsync(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        try
        {
            using var content = new StringContent(JsonSerializer.Serialize(new { agentVersion }, jsonOptions), Encoding.UTF8, "application/json");
            using var response = await httpClient.PostAsync("api/edge/heartbeat", content, ct);
            response.EnsureSuccessStatusCode();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Console.WriteLine($"[{DateTime.UtcNow:HH:mm:ss}] heartbeat failed: {ex.Message}");
        }
        await Task.Delay(TimeSpan.FromSeconds(30), ct);
    }
}

async Task UploadLoopAsync(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        EdgeEventPayload[] pending;
        lock (queue)
        {
            pending = queue.Take(500).ToArray();
        }
        if (pending.Length == 0)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
            continue;
        }

        try
        {
            using var content = new StringContent(JsonSerializer.Serialize(new { events = pending }, jsonOptions), Encoding.UTF8, "application/json");
            using var response = await httpClient.PostAsync("api/edge/events", content, ct);
            response.EnsureSuccessStatusCode();
            var result = await response.Content.ReadFromJsonAsync<EventBatchUploadResponse>(jsonOptions, ct);
            lock (queue)
            {
                var done = result?.Accepted.Concat(result?.Duplicates ?? []) ?? [];
                queue.RemoveAll(e => done.Contains(e.ExternalEventId));
            }
            SaveQueue();
            Console.WriteLine($"[{DateTime.UtcNow:HH:mm:ss}] uploaded {pending.Length} event(s)");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Console.WriteLine($"[{DateTime.UtcNow:HH:mm:ss}] upload failed: {ex.Message}");
            await Task.Delay(TimeSpan.FromSeconds(15), ct);
        }
    }
}

// ponytail: simulated reader = console stdin. Swap for real hardware (serial/TCP reader) when it exists.
async Task ReadLoopAsync(CancellationToken ct)
{
    Console.WriteLine("Reader ready. Simulate a scan: <doorId> <credentialIdentifier>");
    using var reader = new StreamReader(Console.OpenStandardInput());
    while (!ct.IsCancellationRequested)
    {
        var line = await reader.ReadLineAsync(ct);
        if (line is null) break;
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 2 || !Guid.TryParse(parts[0], out var doorId))
        {
            Console.WriteLine("Format: <doorId> <credentialIdentifier>");
            continue;
        }

        var occurredAt = DateTime.UtcNow;
        AccessDecisionEngine? engine;
        lock (snapshotLock)
        {
            engine = snapshot is null ? null : new AccessDecisionEngine(snapshot);
        }

        // Fail closed when unsynced, but always record the event.
        var (decision, reason) = engine is null ? (Decision.Denied, "agent_not_synced") : engine.Evaluate(parts[1], doorId, occurredAt);
        var granted = decision is Decision.Granted or Decision.TemporaryGrant;
        Console.WriteLine($"[{occurredAt:HH:mm:ss}] {(granted ? "GRANTED" : "DENIED")} ({reason})");

        lock (queue)
        {
            queue.Add(new EdgeEventPayload
            {
                DoorId = doorId,
                CredentialIdentifier = parts[1],
                Decision = decision,
                Reason = reason,
                OccurredAtUtc = occurredAt,
            });
        }
        SaveQueue();
    }
}
