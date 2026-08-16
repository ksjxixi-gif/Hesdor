using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Work;
using Hesdor.Application.Work;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/projects")]
public sealed class ProjectsController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly IWorkService _workService;

    public ProjectsController(ApplicationDbContext dbContext, IWorkService workService)
    {
        _dbContext = dbContext;
        _workService = workService;
    }

    [HttpGet]
    [RequirePermission("projects.read")]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var projects = await _dbContext.Projects.AsNoTracking().OrderByDescending(project => project.UpdatedAtUtc).Select(project => new ProjectResponse(project.Id, project.Name, project.Description, project.Status, project.CreatedByEmployeeId, project.CreatedAtUtc, project.UpdatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(projects);
    }

    [HttpGet("{id:guid}")]
    [RequirePermission("projects.read")]
    public async Task<IActionResult> GetById(Guid id, CancellationToken cancellationToken)
    {
        var project = await _dbContext.Projects.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        return project is null ? NotFound() : Ok(ToResponse(project));
    }

    [HttpPost]
    [RequirePermission("projects.manage")]
    public async Task<IActionResult> Create(CreateProjectRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.CreateProjectAsync(new CreateProjectCommand(request.Name, request.Description, request.Status), cancellationToken);
        return result.Succeeded && result.Value is not null ? CreatedAtAction(nameof(GetById), new { id = result.Value.Id }, ToResponse(result.Value)) : BadRequest(new ProblemDetails { Title = "Project creation failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission("projects.manage")]
    public async Task<IActionResult> Update(Guid id, UpdateProjectRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.UpdateProjectAsync(new UpdateProjectCommand(id, request.Name, request.Description, request.Status), cancellationToken);
        return result.Succeeded && result.Value is not null ? Ok(ToResponse(result.Value)) : NotFound(new ProblemDetails { Title = "Project not found.", Status = StatusCodes.Status404NotFound });
    }

    private static ProjectResponse ToResponse(Hesdor.Domain.Work.Project project) => new(project.Id, project.Name, project.Description, project.Status, project.CreatedByEmployeeId, project.CreatedAtUtc, project.UpdatedAtUtc);
}
