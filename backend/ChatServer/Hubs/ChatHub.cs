using ChatServer.Services;
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Hubs;

public class ChatHub : Hub
{
    private const string GeralRoom = "Geral";
    private const string VisualizerGroup = "Visualizador";

    // A topologia deste projeto é sempre fixa (é um estudo de escalonamento com 3
    // réplicas, não um sistema com número variável de instâncias) — por isso os
    // nomes ficam hardcoded aqui, espelhando os valores de REPLICA_NAME no
    // docker-compose.yml. Se um dia mudarem, os dois lugares precisam acompanhar.
    private static readonly string[] AllReplicaNames = ["Servidor A", "Servidor B", "Servidor C"];

    private readonly ILogger<ChatHub> _logger;
    private readonly IRoomPresenceService _presence;
    private readonly string _replicaName;

    public ChatHub(ILogger<ChatHub> logger, IConfiguration configuration, IRoomPresenceService presence)
    {
        _logger = logger;
        _presence = presence;
        _replicaName = configuration["REPLICA_NAME"] ?? "local";
    }

    public override async Task OnConnectedAsync()
    {
        var userName = Context.UserIdentifier;
        if (string.IsNullOrWhiteSpace(userName))
        {
            // Sem identidade não há como manter a presença nem endereçar mensagens
            // privadas a essa conexão — em vez de aceitar a conexão "muda" e deixar
            // ela transmitir como "desconhecido" (invisível na lista online), rejeita
            // de cara.
            //
            // Importante: NÃO chama Context.Abort() aqui. Testamos ao vivo e
            // Abort() logo depois de um SendAsync pode derrubar a conexão antes
            // da mensagem realmente sair pela rede (o await do SendAsync só
            // garante que a mensagem foi entregue pro buffer de saída do
            // SignalR, não que já foi escrita no socket) — o cliente nunca via
            // o "JoinRejected" e o withAutomaticReconnect() ficava tentando de
            // novo (e sendo recusado de novo) num loop silencioso. Em vez disso,
            // só retorna sem entrar em nenhum grupo nem contar presença — é o
            // PRÓPRIO CLIENTE que fecha a conexão ao processar essa mensagem
            // (ver ChatService), garantindo que a entrega já aconteceu antes de
            // qualquer coisa fechar.
            await Clients.Caller.SendAsync("JoinRejected", "Nome de usuário inválido.");
            return;
        }

        // O nome de usuário funciona como identidade única no sistema inteiro —
        // é como o SignalR endereça mensagem privada (Clients.User(nome)) e é o
        // que aparece pra todo mundo saber quem é quem. Duas conexões com o
        // mesmo nome ficam indistinguíveis (a presença no Redis conta por nome,
        // não por conexão), então recusa a segunda tentativa de entrar com um
        // nome já em uso agora — igual todo chat de verdade faz. Existe uma
        // corrida estreita aqui (duas pessoas entrando com o mesmo nome bem no
        // mesmo instante podem ambas passar por essa checagem antes de
        // qualquer uma ser contada); aceitável pro escopo deste projeto.
        var existingUsers = await _presence.GetUsersAsync(GeralRoom);
        if (existingUsers.Contains(userName))
        {
            await Clients.Caller.SendAsync("JoinRejected", "Esse nome já está em uso por outra pessoa. Escolha outro nome.");
            return;
        }

        // Marca que essa conexão realmente entrou (presença contada, grupos
        // entrados) — OnDisconnectedAsync usa isso pra saber se tem alguma
        // presença dela pra remover. Sem essa marca, uma conexão recusada que
        // eventualmente desconecta (o cliente chama stop() sozinho) chamaria
        // RemoveUserAsync mesmo nunca tendo chamado AddUserAsync, decrementando
        // por engano a contagem de uma conexão de verdade com o mesmo nome.
        Context.Items["Joined"] = true;

        await Groups.AddToGroupAsync(Context.ConnectionId, GeralRoom);

        var onlineUsers = await _presence.AddUserAsync(GeralRoom, userName);
        await _presence.AddUserAsync(_replicaName, userName);

        _logger.LogInformation("[{Replica}] {User} entrou na Sala Geral", _replicaName, userName);

        await Clients.Caller.SendAsync("RoomJoined", onlineUsers);
        await Clients.OthersInGroup(GeralRoom).SendAsync("UserJoined", userName, _replicaName);

        var snapshot = new Dictionary<string, string[]>();
        foreach (var replica in AllReplicaNames)
        {
            var usersInReplica = await _presence.GetUsersAsync(replica);
            snapshot[replica] = usersInReplica.ToArray();
        }
        // O snapshot e mandado ANTES de entrar no grupo do visualizador de proposito:
        // assim este cliente nunca pode receber um evento ao vivo (VisualizerUserConnected
        // de outra pessoa, por exemplo) sobre algo que o snapshot ainda nao reflete —
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

        // O timestamp é gerado aqui, em UTC, e não já formatado — o navegador de quem
        // recebe é quem aplica o fuso horário local. O container pode estar rodando em
        // um fuso diferente do de quem está usando o chat, então formatar no servidor
        // mostraria a hora errada.
        var timestamp = DateTimeOffset.UtcNow.ToString("o");
        await Clients.Group(GeralRoom).SendAsync("ReceiveMessage", userName, message, _replicaName, timestamp);

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
        // terceiros — só os nomes das réplicas envolvidas, pra provar que o caminho
        // técnico existe sem expor quem conversa com quem.
        var toReplicas = await GetReplicasForUserAsync(toUserName);
        await Clients.Group(VisualizerGroup).SendAsync("VisualizerPrivateMessage", _replicaName, toReplicas);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userName = Context.UserIdentifier;
        // Uma conexão que foi recusada em OnConnectedAsync (nome inválido ou já
        // em uso) nunca chamou AddUserAsync nem entrou em nenhum grupo — sem
        // essa checagem, o disconnect dela chamaria RemoveUserAsync mesmo assim
        // e decrementaria por engano a contagem de uma conexão de verdade com o
        // mesmo nome (ver Context.Items["Joined"] em OnConnectedAsync).
        if (!string.IsNullOrEmpty(userName) && Context.Items.ContainsKey("Joined"))
        {
            await _presence.RemoveUserAsync(GeralRoom, userName);
            var remainingInReplica = await _presence.RemoveUserAsync(_replicaName, userName);

            _logger.LogInformation("[{Replica}] {User} saiu da Sala Geral", _replicaName, userName);

            await Clients.Group(GeralRoom).SendAsync("UserLeft", userName, _replicaName);

            // So anuncia a desconexao no visualizador quando essa era a ULTIMA conexao
            // dessa pessoa nesta replica especifica — com varias abas na mesma replica,
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
