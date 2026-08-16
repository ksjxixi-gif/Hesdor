namespace Hesdor.Application.Common;

public interface IDateTimeProvider
{
    DateTime UtcNow { get; }
}
