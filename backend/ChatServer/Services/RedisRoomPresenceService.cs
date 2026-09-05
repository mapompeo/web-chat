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

    // Incrementar/decrementar + expirar (e, no remove, apagar o campo quando a
    // contagem chega a zero) precisam acontecer como uma única operação atômica no
    // Redis — se fossem 2-3 comandos separados, uma operação concorrente na mesma
    // conexão/usuário poderia se intrometer entre eles (ex: alguém reconectando
    // exatamente enquanto a conexão antiga está desconectando) e corromper a
    // contagem. Um script Lua roda inteiro, sem interrupção, do lado do servidor.
    private const string AddScript = @"
        redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
        return redis.status_reply('OK')
    ";

    private const string RemoveScript = @"
        local count = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
        if count <= 0 then
            redis.call('HDEL', KEYS[1], ARGV[1])
        end
        redis.call('PEXPIRE', KEYS[1], ARGV[2])
        return redis.status_reply('OK')
    ";

    private readonly IConnectionMultiplexer _redis;

    public RedisRoomPresenceService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    // A presença é uma HASH (userName -> contagem de conexões), não um SET de nomes.
    // Isso resolve dois problemas: múltiplas abas com o mesmo usuário (cada conexão
    // incrementa/decrementa o contador, e o usuário só some quando a ÚLTIMA conexão
    // cai) e a corrida de F5 entre réplicas diferentes (a nova conexão incrementa
    // antes ou depois da remoção da antiga cair, mas o contador nunca fica em 0
    // enquanto houver pelo menos uma conexão viva, então o usuário nunca some
    // indevidamente da lista).
    public async Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.ScriptEvaluateAsync(
            AddScript,
            new RedisKey[] { RoomKey(roomName) },
            new RedisValue[] { userName, (long)PresenceTtl.TotalMilliseconds });
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.ScriptEvaluateAsync(
            RemoveScript,
            new RedisKey[] { RoomKey(roomName) },
            new RedisValue[] { userName, (long)PresenceTtl.TotalMilliseconds });
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> GetUsersAsync(string roomName)
    {
        var db = _redis.GetDatabase();
        var fields = await db.HashKeysAsync(RoomKey(roomName));
        return fields.Select(f => f.ToString()).ToList();
    }

    private static string RoomKey(string roomName) => $"room:{roomName}:presence-count";
}
