using Hesdor.Application.Audit;
using Hesdor.Application.Common;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;

namespace Hesdor.Infrastructure.Audit;

public sealed class AuditWriter : IAuditWriter
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly ILogger<AuditWriter> _logger;

    public AuditWriter(
        ApplicationDbContext dbContext,
        ICurrentUserService currentUserService,
        IDateTimeProvider dateTimeProvider,
        IHttpContextAccessor httpContextAccessor,
        ILogger<AuditWriter> logger)
    {
        _dbContext = dbContext;
        _currentUserService = currentUserService;
        _dateTimeProvider = dateTimeProvider;
        _httpContextAccessor = httpContextAccessor;
        _logger = logger;
    }

    public Task RecordAsync(
        AuditEventInput input,
        CancellationToken cancellationToken = default)
    {
        if (input.TenantId == Guid.Empty)
        {
            throw new InvalidOperationException("Audit events require a tenant.");
        }

        if (_currentUserService.IsAuthenticated && input.TenantId != _currentUserService.TenantId)
        {
            throw new UnauthorizedAccessException("An audit event cannot be written to another tenant.");
        }

        var httpContext = _httpContextAccessor.HttpContext;
        var auditEvent = new AuditEvent
        {
            TenantId = input.TenantId,
            ActorUserId = _currentUserService.UserId,
            ActorEmail = _currentUserService.Email,
            Action = input.Action,
            Result = input.Result,
            EntityType = input.EntityType,
            EntityId = input.EntityId,
            PreviousValue = input.PreviousValue,
            NewValue = input.NewValue,
            IpAddress = httpContext?.Connection.RemoteIpAddress?.ToString(),
            UserAgent = httpContext?.Request.Headers.UserAgent.ToString(),
            MetadataJson = input.MetadataJson,
            OccurredAtUtc = _dateTimeProvider.UtcNow,
            Severity = input.Severity
        };

        _dbContext.AuditEvents.Add(auditEvent);
        _logger.LogInformation(
            "Audit event {Action} recorded for {EntityType} {EntityId} in tenant {TenantId}",
            input.Action,
            input.EntityType,
            input.EntityId,
            input.TenantId);

        return Task.CompletedTask;
    }
}
