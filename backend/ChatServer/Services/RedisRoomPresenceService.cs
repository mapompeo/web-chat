using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisRoomPresenceService : IRoomPresenceService
{
    // Não é uma solução perfeita: se a sala ficar totalmente parada (ninguém entra
    // ou sai) por mais de 4h, a chave expira mesmo com gente ainda conectada — nesse
    // caso a próxima entrada/saída recria a chave normalmente. O objetivo aqui é só
    // evitar usuários "fantasma" presos pra sempre depois de uma queda abrupta do
    // servidor (ex: falta de energia), não substituir uma heartbeat de verdade.
    private static readonly TimeSpan PresenceTtl = TimeSpan.FromHours(4);

    private readonly IConnectionMultiplexer _redis;

    public RedisRoomPresenceService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetAddAsync(RoomKey(roomName), userName);
        await db.KeyExpireAsync(RoomKey(roomName), PresenceTtl);
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetRemoveAsync(RoomKey(roomName), userName);
        await db.KeyExpireAsync(RoomKey(roomName), PresenceTtl);
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
