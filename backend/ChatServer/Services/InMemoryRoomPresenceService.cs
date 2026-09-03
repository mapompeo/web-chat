using System.Collections.Concurrent;

namespace ChatServer.Services;

public class InMemoryRoomPresenceService : IRoomPresenceService
{
    private readonly ConcurrentDictionary<string, HashSet<string>> _rooms = new();
    private readonly object _lock = new();

    public Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        lock (_lock)
        {
            var users = _rooms.GetOrAdd(roomName, _ => new HashSet<string>());
            users.Add(userName);
            return Task.FromResult<IReadOnlyList<string>>(users.ToList());
        }
    }

    public Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        lock (_lock)
        {
            if (_rooms.TryGetValue(roomName, out var users))
            {
                users.Remove(userName);
                return Task.FromResult<IReadOnlyList<string>>(users.ToList());
            }
            return Task.FromResult<IReadOnlyList<string>>(new List<string>());
        }
    }
}
