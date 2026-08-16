namespace Hesdor.Application.Edge;

public interface IEdgeCredentialService
{
    string GenerateCredential();
    string HashCredential(string credential);
}
