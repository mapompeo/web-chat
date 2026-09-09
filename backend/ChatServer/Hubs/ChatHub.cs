using ChatServer.Services;
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Hubs;

public class ChatHub : Hub
{
    // Publicas porque o ReplicaHeartbeatService precisa avisar os mesmos
    // grupos quando limpa a presenca de uma replica que morreu.
    public const string GeralRoom = "Geral";
    public const string VisualizerGroup = "Visualizador";

    // A topologia deste projeto é sempre fixa (é um estudo de escalonamento com 3
    // réplicas, não um sistema com número variável de instâncias), por isso os
    // nomes ficam hardcoded aqui, espelhando os valores de REPLICA_NAME no
    // docker-compose.yml. Se um dia mudarem, os dois lugares precisam acompanhar.
    public static readonly string[] AllReplicaNames = ["Servidor A", "Servidor B", "Servidor C"];

    private readonly ILogger<ChatHub> _logger;
    private readonly IRoomPresenceService _presence;
    private readonly IReplicaRegistry _replicas;
    private readonly IMessageHistoryService _history;
    private readonly INameOwnershipService _names;
    private readonly string _replicaName;

    public ChatHub(
        ILogger<ChatHub> logger,
        IConfiguration configuration,
        IRoomPresenceService presence,
        IReplicaRegistry replicas,
        IMessageHistoryService history,
        INameOwnershipService names)
    {
        _logger = logger;
        _presence = presence;
        _replicas = replicas;
        _history = history;
        _names = names;
        _replicaName = configuration["REPLICA_NAME"] ?? "local";
    }

    public override async Task OnConnectedAsync()
    {
        var userName = Context.UserIdentifier;
        if (string.IsNullOrWhiteSpace(userName))
        {
            // Sem identidade não dá pra manter presença nem endereçar mensagem
            // privada. Note que NÃO chamamos Context.Abort(): abortar logo depois
            // de um SendAsync pode fechar a conexão antes de a mensagem sair pela
            // rede, e o cliente nunca recebia a recusa. Quem fecha é o próprio
            // cliente, ao processar este evento (ver ChatService).
            await Clients.Caller.SendAsync("JoinRejected", "Nome de usuário inválido.");
            return;
        }

        // O nome é a identidade do sistema: é por ele que Clients.User(...)
        // endereça mensagem privada. A pergunta que importa é "esse nome
        // pertence a OUTRO cliente?", e não "esse nome existe?": quando uma
        // réplica morre de repente, o registro que a pessoa deixou sobrevive
        // alguns segundos, e a reconexão dela batia no próprio registro e era
        // recusada. Ver INameOwnershipService.
        var clientId = Context.GetHttpContext()?.Request.Query["client"].ToString();
        if (string.IsNullOrWhiteSpace(clientId))
        {
            // Cliente antigo ou chamada fora do app: cai no identificador da
            // própria conexão, que é único, então ele nunca "reconecta" no
            // sentido acima, mas também nunca rouba o nome de ninguém.
            clientId = Context.ConnectionId;
        }

        if (!await _names.TryClaimAsync(GeralRoom, userName, clientId))
        {
            await Clients.Caller.SendAsync("JoinRejected", "Esse nome já está em uso por outra pessoa. Escolha outro nome.");
            return;
        }

        Context.Items["ClientId"] = clientId;

        // Marca que esta conexão de fato entrou. OnDisconnectedAsync consulta
        // isso pra não descontar presença de uma conexão que foi recusada e
        // portanto nunca foi contada.
        Context.Items["Joined"] = true;

        // Antes de entrar no grupo, pela mesma razão do snapshot mais abaixo:
        // nenhuma mensagem ao vivo pode chegar antes do histórico e ser
        // sobrescrita quando ele preencher a lista.
        var history = await _history.GetRecentAsync(GeralRoom);
        await Clients.Caller.SendAsync("RoomHistory", history);

        await Groups.AddToGroupAsync(Context.ConnectionId, GeralRoom);

        var onlineUsers = await _presence.AddUserAsync(GeralRoom, userName);
        await _presence.AddUserAsync(_replicaName, userName);

        _logger.LogInformation("[{Replica}] {User} entrou na Sala Geral", _replicaName, userName);

        await Clients.Caller.SendAsync("RoomJoined", onlineUsers);
        // Qual réplica atendeu ESTA conexão: é o que torna o balanceamento
        // perceptível, porque ao derrubar uma réplica dá pra ver a reconexão
        // trazer outro servidor aqui.
        await Clients.Caller.SendAsync("ConnectedToReplica", _replicaName);
        await Clients.OthersInGroup(GeralRoom).SendAsync("UserJoined", userName, _replicaName);

        var snapshot = new Dictionary<string, string[]>();
        foreach (var replica in AllReplicaNames)
        {
            var usersInReplica = await _presence.GetUsersAsync(replica);
            snapshot[replica] = usersInReplica.ToArray();
        }
        // O snapshot e mandado ANTES de entrar no grupo do visualizador de proposito:
        // assim este cliente nunca pode receber um evento ao vivo (VisualizerUserConnected
        // de outra pessoa, por exemplo) sobre algo que o snapshot ainda nao reflete;
        // fechando uma janela de corrida onde um evento anterior ao snapshot seria
        // descartado quando o snapshot sobrescrevesse o mapa inteiro.
        await Clients.Caller.SendAsync("VisualizerSnapshot", snapshot);
        await Groups.AddToGroupAsync(Context.ConnectionId, VisualizerGroup);
        await Clients.OthersInGroup(VisualizerGroup).SendAsync("VisualizerUserConnected", _replicaName, userName);

        await base.OnConnectedAsync();
    }

    public async Task SendMessage(string message)
    {
        var userName = Context.UserIdentifier ?? "desconhecido";

        _logger.LogInformation(
            "[{Replica}] mensagem de {User} na Sala Geral: {Message}",
            _replicaName, userName, message);

        // UTC e sem formatar: quem aplica o fuso é o navegador de quem recebe,
        // já que o container pode estar num fuso diferente.
        var timestamp = DateTimeOffset.UtcNow.ToString("o");
        await Clients.Group(GeralRoom).SendAsync("ReceiveMessage", userName, message, _replicaName, timestamp);

        // Depois da entrega, não antes: se o Redis falhar aqui, o pior caso é
        // perder a mensagem do histórico, não deixar de entregá-la.
        await _history.AddAsync(
            GeralRoom,
            new StoredMessage(userName, message, _replicaName, timestamp));

        var activeReplicas = await GetActiveReplicasAsync();
        await Clients.Group(VisualizerGroup).SendAsync("VisualizerGeralMessage", _replicaName, userName, activeReplicas);
    }

    public async Task SendPrivateMessage(string toUserName, string message)
    {
        var fromUserName = Context.UserIdentifier ?? "desconhecido";

        _logger.LogInformation(
            "[{Replica}] mensagem privada de {From} para {To}: {Message}",
            _replicaName, fromUserName, toUserName, message);

        var timestamp = DateTimeOffset.UtcNow.ToString("o");
        await Clients.User(toUserName).SendAsync("ReceivePrivateMessage", fromUserName, message, _replicaName, timestamp);

        // O visualizador nunca recebe nome nem conteúdo de mensagem privada de
        // terceiros, só os nomes das réplicas envolvidas, pra provar que o caminho
        // técnico existe sem expor quem conversa com quem.
        var toReplicas = await GetReplicasForUserAsync(toUserName);
        await Clients.Group(VisualizerGroup).SendAsync("VisualizerPrivateMessage", _replicaName, toReplicas);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userName = Context.UserIdentifier;
        // Uma conexão que foi recusada em OnConnectedAsync (nome inválido ou já
        // em uso) nunca chamou AddUserAsync nem entrou em nenhum grupo; sem
        // essa checagem, o disconnect dela chamaria RemoveUserAsync mesmo assim
        // e decrementaria por engano a contagem de uma conexão de verdade com o
        // mesmo nome (ver Context.Items["Joined"] em OnConnectedAsync).
        if (!string.IsNullOrEmpty(userName) && Context.Items.ContainsKey("Joined"))
        {
            var remainingInRoom = await _presence.RemoveUserAsync(GeralRoom, userName);
            var remainingInReplica = await _presence.RemoveUserAsync(_replicaName, userName);

            // Só devolve o nome quando some a última conexão dessa pessoa em
            // qualquer réplica; enquanto restar alguma, o nome segue sendo dela.
            if (!remainingInRoom.Contains(userName)
                && Context.Items.TryGetValue("ClientId", out var clientId)
                && clientId is string id)
            {
                await _names.ReleaseAsync(GeralRoom, userName, id);
            }

            _logger.LogInformation("[{Replica}] {User} saiu da Sala Geral", _replicaName, userName);

            await Clients.Group(GeralRoom).SendAsync("UserLeft", userName, _replicaName);

            // So anuncia a desconexao no visualizador quando essa era a ULTIMA conexao
            // dessa pessoa nesta replica especifica; com varias abas na mesma replica,
            // fechar uma delas nao deve fazer a pessoa sumir do painel de todo mundo
            // enquanto ela ainda estiver conectada por outra aba na mesma replica.
            if (!remainingInReplica.Contains(userName))
            {
                await Clients.Group(VisualizerGroup).SendAsync("VisualizerUserDisconnected", _replicaName, userName);
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    private async Task<string[]> GetActiveReplicasAsync()
    {
        var active = new List<string>();
        foreach (var replica in AllReplicaNames)
        {
            var users = await _presence.GetUsersAsync(replica);
            if (users.Count > 0)
            {
                active.Add(replica);
            }
        }
        return active.ToArray();
    }

    private async Task<string[]> GetReplicasForUserAsync(string userName)
    {
        var replicas = new List<string>();
        foreach (var replica in AllReplicaNames)
        {
            var users = await _presence.GetUsersAsync(replica);
            if (users.Contains(userName))
            {
                replicas.Add(replica);
            }
        }
        return replicas.ToArray();
    }
}
