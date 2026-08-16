using Hesdor.Api.Models.Auth;
using Hesdor.Application.Identity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using BootstrapRequestDto = Hesdor.Api.Models.Auth.BootstrapRequest;

namespace Hesdor.Api.Controllers;

[ApiController]
[Route("api/auth")]
[EnableRateLimiting("auth")]
public sealed class AuthController : ControllerBase
{
    private readonly IAuthenticationService _authenticationService;

    public AuthController(IAuthenticationService authenticationService)
    {
        _authenticationService = authenticationService;
    }

    [AllowAnonymous]
    [HttpPost("bootstrap")]
    public async Task<ActionResult<LoginResponse>> Bootstrap(
        BootstrapRequestDto request,
        CancellationToken cancellationToken)
    {
        var result = await _authenticationService.BootstrapAsync(
            new Hesdor.Application.Identity.BootstrapRequest(
                request.OrganizationName,
                request.DisplayName,
                request.Email,
                request.Password,
                request.Slug),
            cancellationToken);

        return result.Succeeded && result.Token is not null
            ? Ok(ToResponse(result.Token))
            : Problem(
                detail: result.FailureReason ?? "Initial organization setup failed.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Organization setup unavailable");
    }

    [AllowAnonymous]
    [HttpPost("login")]
    public async Task<ActionResult<LoginResponse>> Login(
        LoginRequest request,
        CancellationToken cancellationToken)
    {
        var result = await _authenticationService.AuthenticateAsync(
            new AuthenticationRequest(request.Email, request.Password),
            cancellationToken);

        return result.Succeeded && result.Token is not null
            ? Ok(ToResponse(result.Token))
            : Problem(
                detail: result.FailureReason ?? "Invalid credentials.",
                statusCode: StatusCodes.Status401Unauthorized,
                title: "Authentication failed");
    }

    [AllowAnonymous]
    [HttpPost("refresh")]
    public async Task<ActionResult<LoginResponse>> Refresh(
        RefreshRequest request,
        CancellationToken cancellationToken)
    {
        var result = await _authenticationService.RefreshAsync(
            new RefreshTokenRequest(request.RefreshToken),
            cancellationToken);

        return result.Succeeded && result.Token is not null
            ? Ok(ToResponse(result.Token))
            : Problem(
                detail: result.FailureReason ?? "Refresh token is invalid.",
                statusCode: StatusCodes.Status401Unauthorized,
                title: "Session refresh failed");
    }

    [AllowAnonymous]
    [HttpPost("revoke")]
    public async Task<IActionResult> Revoke(
        RefreshRequest request,
        CancellationToken cancellationToken)
    {
        await _authenticationService.RevokeRefreshTokenAsync(
            new RefreshTokenRequest(request.RefreshToken),
            cancellationToken);
        return NoContent();
    }

    private static LoginResponse ToResponse(TokenResult token) => new(
        token.AccessToken,
        token.RefreshToken,
        token.ExpiresAtUtc,
        token.RefreshTokenExpiresAtUtc);
}
