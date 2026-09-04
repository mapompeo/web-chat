using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisRoomPresenceService : IRoomPresenceService
{
    private readonly IConnectionMultiplexer _redis;

    public RedisRoomPresenceService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetAddAsync(RoomKey(roomName), userName);
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetRemoveAsync(RoomKey(roomName), userName);
        return await GetUsersAsync(roomName);
    }

    private async Task<IReadOnlyList<string>> GetUsersAsync(string roomName)
    {
        var db = _redis.GetDatabase();
        var members = await db.SetMembersAsync(RoomKey(roomName));
        return members.Select(m => m.ToString()).ToList();
    }

    private static string RoomKey(string roomName) => $"room:{roomName}:users";
}
