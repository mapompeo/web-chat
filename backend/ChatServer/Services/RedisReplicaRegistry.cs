using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisReplicaRegistry : IReplicaRegistry
{
    // A chave de "estou viva" vale por este tempo. Precisa ser bem maior que o
    // intervalo entre dois avisos (ver ReplicaHeartbeatService), senão uma
    // pausa qualquer do processo (coleta de lixo, disputa por CPU numa máquina
    // apertada) faria uma réplica saudável ser declarada morta e ter a presença
    // apagada embaixo de conexões que estão funcionando.
    public static readonly TimeSpan AliveTtl = TimeSpan.FromSeconds(20);

    // Apagar a presença de uma réplica morta precisa ser uma operação só. Todas
    // as réplicas vivas varrem em paralelo, e sem atomicidade duas delas
    // limpariam a mesma réplica morta, descontando a mesma pessoa duas vezes da
    // sala e zerando quem ainda estava conectado em outro lugar. Como o script
    // apaga a chave da réplica no fim, quem chegar depois encontra vazio e não
    // faz nada.
    //
    // O desconto usa a CONTAGEM de cada pessoa, não 1: a mesma pessoa pode ter
    // várias abas na mesma réplica, e todas caíram juntas.
    private const string ReapScript = @"
        local entries = redis.call('HGETALL', KEYS[1])
        if #entries == 0 then return {} end
        local removed = {}
        for i = 1, #entries, 2 do
            local user = entries[i]
            local count = tonumber(entries[i + 1])
            local remaining = redis.call('HINCRBY', KEYS[2], user, -count)
            if remaining <= 0 then
                redis.call('HDEL', KEYS[2], user)
                redis.call('HDEL', KEYS[3], user)
                table.insert(removed, user)
            end
        end
        redis.call('DEL', KEYS[1])
        redis.call('PEXPIRE', KEYS[2], ARGV[1])
        return removed
    ";

    private readonly IConnectionMultiplexer _redis;

    public RedisReplicaRegistry(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task HeartbeatAsync(string replicaName)
    {
        var db = _redis.GetDatabase();
        await db.StringSetAsync(AliveKey(replicaName), "1", AliveTtl);
    }

    public async Task<IReadOnlyList<string>> GetAliveAsync(IEnumerable<string> replicaNames)
    {
        var db = _redis.GetDatabase();
        var names = replicaNames.ToList();
        var alive = await Task.WhenAll(names.Select(n => db.KeyExistsAsync(AliveKey(n))));
        return names.Where((_, i) => alive[i]).ToList();
    }

    public async Task<IReadOnlyList<string>> ReapAsync(string deadReplicaName, string roomName)
    {
        var db = _redis.GetDatabase();
        var result = await db.ScriptEvaluateAsync(
            ReapScript,
            new RedisKey[]
            {
                PresenceKey(deadReplicaName),
                PresenceKey(roomName),
                RedisNameOwnershipService.OwnersKey(roomName)
            },
            new RedisValue[] { (long)TimeSpan.FromHours(4).TotalMilliseconds });

        if (result.IsNull)
        {
            return Array.Empty<string>();
        }

        return ((RedisValue[])result!).Select(v => v.ToString()).ToList();
    }

    private static string AliveKey(string replicaName) => $"replica:{replicaName}:alive";

    // Precisa bater com RoomKey do RedisRoomPresenceService: os dois mexem na
    // mesma chave, um contando quem entra e outro limpando quem ficou órfão.
    private static string PresenceKey(string roomName) => $"room:{roomName}:presence-count";
}
