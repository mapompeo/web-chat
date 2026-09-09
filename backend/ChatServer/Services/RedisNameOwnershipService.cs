using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisNameOwnershipService : INameOwnershipService
{
    private static readonly TimeSpan OwnerTtl = TimeSpan.FromHours(4);

    // Ler o dono atual e gravar o novo precisa ser uma operação só: em dois
    // comandos separados, duas pessoas pedindo o mesmo nome livre ao mesmo
    // tempo poderiam ambas ler "livre" e ambas gravar, e as duas entrariam.
    private const string ClaimScript = @"
        local owner = redis.call('HGET', KEYS[1], ARGV[1])
        if owner and owner ~= ARGV[2] then
            return 0
        end
        redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
        redis.call('PEXPIRE', KEYS[1], ARGV[3])
        return 1
    ";

    private const string ReleaseScript = @"
        local owner = redis.call('HGET', KEYS[1], ARGV[1])
        if owner == ARGV[2] then
            redis.call('HDEL', KEYS[1], ARGV[1])
        end
        return redis.status_reply('OK')
    ";

    private readonly IConnectionMultiplexer _redis;

    public RedisNameOwnershipService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task<bool> TryClaimAsync(string roomName, string userName, string clientId)
    {
        var db = _redis.GetDatabase();
        var result = await db.ScriptEvaluateAsync(
            ClaimScript,
            new RedisKey[] { OwnersKey(roomName) },
            new RedisValue[] { userName, clientId, (long)OwnerTtl.TotalMilliseconds });
        return (int)result == 1;
    }

    public async Task ReleaseAsync(string roomName, string userName, string clientId)
    {
        var db = _redis.GetDatabase();
        await db.ScriptEvaluateAsync(
            ReleaseScript,
            new RedisKey[] { OwnersKey(roomName) },
            new RedisValue[] { userName, clientId });
    }

    // Precisa bater com a chave usada em RedisReplicaRegistry.ReapAsync, que
    // apaga os donos junto com a presença de uma réplica que morreu.
    public static string OwnersKey(string roomName) => $"room:{roomName}:owners";
}
