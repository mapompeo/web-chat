using System.Text.Json;
using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisMessageHistoryService : IMessageHistoryService
{
    // Quantas mensagens ficam guardadas. O suficiente pra encher a tela de quem
    // acabou de entrar, sem transformar o Redis num banco de mensagens: o
    // projeto continua sem histórico de verdade (ver README).
    private const int MaxMessages = 50;

    // Mesmo prazo das chaves de presença, pela mesma razão: uma sala abandonada
    // não deve deixar lixo no Redis pra sempre.
    private static readonly TimeSpan HistoryTtl = TimeSpan.FromHours(4);

    // Empilhar, cortar o excedente e renovar o prazo precisam acontecer como uma
    // operação só. Em três comandos separados, duas mensagens chegando ao mesmo
    // tempo (de réplicas diferentes) poderiam se intercalar entre o LPUSH e o
    // LTRIM e deixar a lista maior que o limite.
    private const string AddScript = @"
        redis.call('LPUSH', KEYS[1], ARGV[1])
        redis.call('LTRIM', KEYS[1], 0, ARGV[2] - 1)
        redis.call('PEXPIRE', KEYS[1], ARGV[3])
        return redis.status_reply('OK')
    ";

    private readonly IConnectionMultiplexer _redis;

    public RedisMessageHistoryService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task AddAsync(string roomName, StoredMessage message)
    {
        var db = _redis.GetDatabase();
        await db.ScriptEvaluateAsync(
            AddScript,
            new RedisKey[] { HistoryKey(roomName) },
            new RedisValue[]
            {
                JsonSerializer.Serialize(message),
                MaxMessages,
                (long)HistoryTtl.TotalMilliseconds
            });
    }

    public async Task<IReadOnlyList<StoredMessage>> GetRecentAsync(string roomName)
    {
        var db = _redis.GetDatabase();
        var items = await db.ListRangeAsync(HistoryKey(roomName));

        // LPUSH coloca no início, então a lista sai da mais nova pra mais
        // antiga; a tela precisa do contrário.
        return items
            .Reverse()
            .Select(i => JsonSerializer.Deserialize<StoredMessage>(i.ToString()))
            .Where(m => m is not null)
            .Select(m => m!)
            .ToList();
    }

    private static string HistoryKey(string roomName) => $"room:{roomName}:history";
}
