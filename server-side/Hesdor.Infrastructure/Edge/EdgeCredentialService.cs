using System.Security.Cryptography;
using System.Text;
using Hesdor.Application.Edge;

namespace Hesdor.Infrastructure.Edge;

public sealed class EdgeCredentialService : IEdgeCredentialService
{
    public string GenerateCredential()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(64))
            .Replace("+", "-", StringComparison.Ordinal)
            .Replace("/", "_", StringComparison.Ordinal)
            .TrimEnd('=');
    }

    public string HashCredential(string credential)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(credential)));
    }
}
