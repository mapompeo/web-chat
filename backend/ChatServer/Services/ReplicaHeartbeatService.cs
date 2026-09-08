using ChatServer.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Services;

/// <summary>
/// Faz duas coisas em intervalos curtos: avisa que esta réplica está viva e
/// varre as outras procurando alguma que parou de avisar, pra limpar a
/// presença que ela deixou órfã.
///
/// Toda réplica varre todas, inclusive as outras, de propósito: quem morreu não
/// tem como limpar a própria sujeira. Como a limpeza é atômica no Redis (ver
/// RedisReplicaRegistry), várias réplicas varrendo ao mesmo tempo não se
/// atrapalham; a primeira leva os nomes e as demais encontram vazio.
/// </summary>
public class ReplicaHeartbeatService : BackgroundService
{
    // Precisa ser bem menor que RedisReplicaRegistry.AliveTtl, pra uma batida
    // perdida não declarar morta uma réplica que está apenas ocupada.
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly IReplicaRegistry _registry;
    private readonly IHubContext<ChatHub> _hub;
    private readonly ILogger<ReplicaHeartbeatService> _logger;
    private readonly string _replicaName;

    public ReplicaHeartbeatService(
        IReplicaRegistry registry,
        IHubContext<ChatHub> hub,
        IConfiguration configuration,
        ILogger<ReplicaHeartbeatService> logger)
    {
        _registry = registry;
        _hub = hub;
        _logger = logger;
        _replicaName = configuration["REPLICA_NAME"] ?? "local";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Avisa antes de entrar no laço: se a réplica só se anunciasse depois da
        // primeira espera, haveria uma janela no arranque em que ela mesma
        // apareceria como morta pras outras.
        await SafeHeartbeatAsync();

        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await SafeHeartbeatAsync();
            await ReapDeadReplicasAsync();
        }
    }

    private async Task SafeHeartbeatAsync()
    {
        try
        {
            await _registry.HeartbeatAsync(_replicaName);
        }
        catch (Exception ex)
        {
            // Uma falha momentânea de Redis não pode derrubar o laço: se este
            // serviço morrer, a réplica para de se anunciar e as outras acabam
            // apagando a presença de gente que está perfeitamente conectada.
            _logger.LogWarning(ex, "[{Replica}] falha ao anunciar que está viva", _replicaName);
        }
    }

    private async Task ReapDeadReplicasAsync()
    {
        try
        {
            var vivas = await _registry.GetAliveAsync(ChatHub.AllReplicaNames);
            foreach (var morta in ChatHub.AllReplicaNames.Except(vivas))
            {
                var removidos = await _registry.ReapAsync(morta, ChatHub.GeralRoom);
                if (removidos.Count == 0)
                {
                    continue;
                }

                _logger.LogInformation(
                    "[{Replica}] {Morta} parou de responder; removendo {Total} presença(s) órfã(s): {Pessoas}",
                    _replicaName, morta, removidos.Count, string.Join(", ", removidos));

                foreach (var pessoa in removidos)
                {
                    // Os mesmos eventos que OnDisconnectedAsync mandaria se a
                    // réplica tivesse saído de forma limpa, pra lista de online
                    // e visualizador voltarem ao normal sem ninguém precisar
                    // recarregar a página.
                    await _hub.Clients.Group(ChatHub.GeralRoom).SendAsync("UserLeft", pessoa, morta);
                    await _hub.Clients.Group(ChatHub.VisualizerGroup)
                        .SendAsync("VisualizerUserDisconnected", morta, pessoa);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[{Replica}] falha ao varrer réplicas mortas", _replicaName);
        }
    }
}
