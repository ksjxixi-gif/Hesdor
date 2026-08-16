using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Messaging;
using Hesdor.Application.Messaging;
using Hesdor.Application.Common;
using Hesdor.Domain.Messaging;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/announcements")]
public sealed class AnnouncementsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly ICurrentUserService _currentUserService;
    private readonly IMessagingService _messagingService;

    public AnnouncementsController(ApplicationDbContext dbContext, ICurrentUserService currentUserService, IMessagingService messagingService)
    {
        _dbContext = dbContext;
        _currentUserService = currentUserService;
        _messagingService = messagingService;
    }

    [HttpGet]
    [RequirePermission("announcements.read")]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = _currentUserService.UserId;
        var employee = userId is Guid id ? await _dbContext.Users.IgnoreQueryFilters().Where(user => user.Id == id).Select(user => new { user.EmployeeId }).SingleOrDefaultAsync(cancellationToken) : null;
        var employeeId = employee?.EmployeeId;
        var announcements = await _dbContext.Announcements.AsNoTracking().Where(announcement => announcement.Status == AnnouncementStatus.Published && (announcement.ExpiresAtUtc == null || announcement.ExpiresAtUtc > DateTime.UtcNow)).Where(announcement => _dbContext.AnnouncementAudiences.Any(audience => audience.AnnouncementId == announcement.Id && (audience.Type == AnnouncementAudienceType.Company || audience.Type == AnnouncementAudienceType.Employee && employeeId != null && audience.EmployeeId == employeeId || audience.Type == AnnouncementAudienceType.Department && employeeId != null && _dbContext.Employees.Any(e => e.Id == employeeId && e.DepartmentId == audience.DepartmentId) || audience.Type == AnnouncementAudienceType.Team && employeeId != null && _dbContext.EmployeeTeams.Any(et => et.EmployeeId == employeeId && et.TeamId == audience.TeamId)))).OrderByDescending(announcement => announcement.PublishedAtUtc).Select(announcement => new AnnouncementResponse(announcement.Id, announcement.Title, announcement.Body, announcement.Status, announcement.PublishedAtUtc, announcement.ExpiresAtUtc, announcement.CreatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(announcements);
    }

    [HttpPost]
    [RequirePermission("announcements.manage")]
    public async Task<IActionResult> Create(CreateAnnouncementRequest request, CancellationToken cancellationToken)
    {
        var result = await _messagingService.CreateAnnouncementAsync(new CreateAnnouncementCommand(request.Title, request.Body, request.Status, request.PublishedAtUtc, request.ExpiresAtUtc, request.Audiences.Select(audience => new AnnouncementAudienceInput(audience.Type, audience.DepartmentId, audience.TeamId, audience.EmployeeId)).ToArray()), cancellationToken);
        return result.Succeeded && result.Value is not null ? Created($"/api/announcements/{result.Value.Id}", new AnnouncementResponse(result.Value.Id, result.Value.Title, result.Value.Body, result.Value.Status, result.Value.PublishedAtUtc, result.Value.ExpiresAtUtc, result.Value.CreatedAtUtc)) : BadRequest(new ProblemDetails { Title = "Announcement was not created.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }
}
