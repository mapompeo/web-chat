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
        local dados = redis.call('HGETALL', KEYS[1])
        if #dados == 0 then return {} end
        local removidos = {}
        for i = 1, #dados, 2 do
            local pessoa = dados[i]
            local quantas = tonumber(dados[i + 1])
            local restante = redis.call('HINCRBY', KEYS[2], pessoa, -quantas)
            if restante <= 0 then
                redis.call('HDEL', KEYS[2], pessoa)
                redis.call('HDEL', KEYS[3], pessoa)
                table.insert(removidos, pessoa)
            end
        end
        redis.call('DEL', KEYS[1])
        redis.call('PEXPIRE', KEYS[2], ARGV[1])
        return removidos
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
        var nomes = replicaNames.ToList();
        var existe = await Task.WhenAll(nomes.Select(n => db.KeyExistsAsync(AliveKey(n))));
        return nomes.Where((_, i) => existe[i]).ToList();
    }

    public async Task<IReadOnlyList<string>> ReapAsync(string deadReplicaName, string roomName)
    {
        var db = _redis.GetDatabase();
        var resultado = await db.ScriptEvaluateAsync(
            ReapScript,
            new RedisKey[]
            {
                PresenceKey(deadReplicaName),
                PresenceKey(roomName),
                RedisNameOwnershipService.OwnersKey(roomName)
            },
            new RedisValue[] { (long)TimeSpan.FromHours(4).TotalMilliseconds });

        if (resultado.IsNull)
        {
            return Array.Empty<string>();
        }

        return ((RedisValue[])resultado!).Select(v => v.ToString()).ToList();
    }

    private static string AliveKey(string replicaName) => $"replica:{replicaName}:alive";

    // Precisa bater com RoomKey do RedisRoomPresenceService: os dois mexem na
    // mesma chave, um contando quem entra e outro limpando quem ficou órfão.
    private static string PresenceKey(string roomName) => $"room:{roomName}:presence-count";
}
