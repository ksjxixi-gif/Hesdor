using Hesdor.Api.Authorization;
using Hesdor.Api.Models.Work;
using Hesdor.Application.Work;
using Hesdor.Domain.Work;
using Hesdor.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Api.Controllers;

[ApiController]
[Authorize]
[Route("api/tasks")]
public sealed class TasksController : ControllerBase
{
    private readonly ApplicationDbContext _dbContext;
    private readonly IWorkService _workService;

    public TasksController(ApplicationDbContext dbContext, IWorkService workService)
    {
        _dbContext = dbContext;
        _workService = workService;
    }

    [HttpGet]
    [RequirePermission("tasks.read")]
    public async Task<IActionResult> Get([FromQuery] Guid? projectId, [FromQuery] WorkTaskStatus? status, CancellationToken cancellationToken)
    {
        var query = _dbContext.Tasks.AsNoTracking();
        if (projectId is Guid project) query = query.Where(task => task.ProjectId == project);
        if (status is WorkTaskStatus taskStatus) query = query.Where(task => task.Status == taskStatus);
        var tasks = await query.OrderBy(task => task.DueAtUtc).ThenByDescending(task => task.UpdatedAtUtc).ToArrayAsync(cancellationToken);
        return Ok(tasks.Select(ToResponse).ToArray());
    }

    [HttpGet("{id:guid}")]
    [RequirePermission("tasks.read")]
    public async Task<IActionResult> GetById(Guid id, CancellationToken cancellationToken)
    {
        var task = await _dbContext.Tasks.AsNoTracking().SingleOrDefaultAsync(item => item.Id == id, cancellationToken);
        if (task is null) return NotFound();
        var assignees = await _dbContext.TaskAssignees.AsNoTracking().Where(item => item.TaskId == id).Select(item => new TaskAssigneeResponse(item.Id, item.TaskId, item.EmployeeId, item.CreatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(new { task = ToResponse(task), assignees });
    }

    [HttpPost]
    [RequirePermission("tasks.create")]
    public async Task<IActionResult> Create(CreateTaskRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.CreateTaskAsync(new CreateTaskCommand(request.ProjectId, request.ParentTaskId, request.Title, request.Description, request.Status, request.Priority, request.DueAtUtc), cancellationToken);
        return result.Succeeded && result.Value is not null ? CreatedAtAction(nameof(GetById), new { id = result.Value.Id }, ToResponse(result.Value)) : BadRequest(new ProblemDetails { Title = "Task creation failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpPatch("{id:guid}")]
    [RequirePermission("tasks.update")]
    public async Task<IActionResult> Update(Guid id, UpdateTaskRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.UpdateTaskAsync(new UpdateTaskCommand(id, request.Title, request.Description, request.Status, request.Priority, request.DueAtUtc, request.ClearDueAt), cancellationToken);
        return result.Succeeded && result.Value is not null ? Ok(ToResponse(result.Value)) : NotFound(new ProblemDetails { Title = "Task not found.", Status = StatusCodes.Status404NotFound });
    }

    [HttpPost("{id:guid}/assignees")]
    [RequirePermission("tasks.assign")]
    public async Task<IActionResult> Assign(Guid id, AssignTaskRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.AssignTaskAsync(new AssignTaskCommand(id, request.EmployeeId), cancellationToken);
        return result.Succeeded && result.Value is not null ? Created($"/api/tasks/{id}/assignees/{request.EmployeeId}", new TaskAssigneeResponse(result.Value.Id, result.Value.TaskId, result.Value.EmployeeId, result.Value.CreatedAtUtc)) : BadRequest(new ProblemDetails { Title = "Task assignment failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpDelete("{id:guid}/assignees/{employeeId:guid}")]
    [RequirePermission("tasks.assign")]
    public async Task<IActionResult> Unassign(Guid id, Guid employeeId, CancellationToken cancellationToken)
    {
        var result = await _workService.RemoveTaskAssigneeAsync(new RemoveTaskAssigneeCommand(id, employeeId), cancellationToken);
        return result.Succeeded ? NoContent() : NotFound(new ProblemDetails { Title = "Task assignee not found.", Status = StatusCodes.Status404NotFound });
    }

    [HttpGet("{id:guid}/comments")]
    [RequirePermission("tasks.read")]
    public async Task<IActionResult> GetComments(Guid id, CancellationToken cancellationToken)
    {
        var comments = await _dbContext.TaskComments.AsNoTracking().Where(comment => comment.TaskId == id).OrderBy(comment => comment.CreatedAtUtc).Select(comment => new TaskCommentResponse(comment.Id, comment.TaskId, comment.AuthorEmployeeId, comment.Body, comment.CreatedAtUtc, comment.UpdatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(comments);
    }

    [HttpPost("{id:guid}/comments")]
    [RequirePermission("tasks.comment")]
    public async Task<IActionResult> AddComment(Guid id, AddTaskCommentRequest request, CancellationToken cancellationToken)
    {
        var result = await _workService.AddTaskCommentAsync(new AddTaskCommentCommand(id, request.Body), cancellationToken);
        return result.Succeeded && result.Value is not null ? Created($"/api/tasks/{id}/comments/{result.Value.Id}", new TaskCommentResponse(result.Value.Id, result.Value.TaskId, result.Value.AuthorEmployeeId, result.Value.Body, result.Value.CreatedAtUtc, result.Value.UpdatedAtUtc)) : BadRequest(new ProblemDetails { Title = "Task comment failed.", Detail = result.FailureReason, Status = StatusCodes.Status400BadRequest });
    }

    [HttpGet("{id:guid}/activity")]
    [RequirePermission("tasks.read")]
    public async Task<IActionResult> GetActivity(Guid id, CancellationToken cancellationToken)
    {
        var activity = await _dbContext.TaskActivities.AsNoTracking().Where(item => item.TaskId == id).OrderByDescending(item => item.CreatedAtUtc).Select(item => new TaskActivityResponse(item.Id, item.TaskId, item.ActorEmployeeId, item.Type, item.MetadataJson, item.CreatedAtUtc)).ToArrayAsync(cancellationToken);
        return Ok(activity);
    }

    private static TaskResponse ToResponse(WorkTask task) => new(task.Id, task.ProjectId, task.ParentTaskId, task.Title, task.Description, task.Status, task.Priority, task.DueAtUtc, task.CreatedByEmployeeId, task.CreatedAtUtc, task.UpdatedAtUtc);
}
