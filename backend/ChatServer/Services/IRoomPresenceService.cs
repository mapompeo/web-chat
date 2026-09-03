namespace ChatServer.Services;

public interface IRoomPresenceService
{
    Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName);
    Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName);
}
