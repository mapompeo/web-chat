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
            // Sem identidade não há como manter a presença nem endereçar mensagens
            // privadas a essa conexão, em vez de aceitar a conexão "muda" e deixar
            // ela transmitir como "desconhecido" (invisível na lista online), rejeita
            // de cara.
            //
            // Importante: NÃO chama Context.Abort() aqui. Testamos ao vivo e
            // Abort() logo depois de um SendAsync pode derrubar a conexão antes
            // da mensagem realmente sair pela rede (o await do SendAsync só
            // garante que a mensagem foi entregue pro buffer de saída do
            // SignalR, não que já foi escrita no socket); o cliente nunca via
            // o "JoinRejected" e o withAutomaticReconnect() ficava tentando de
            // novo (e sendo recusado de novo) num loop silencioso. Em vez disso,
            // só retorna sem entrar em nenhum grupo nem contar presença; é o
            // PRÓPRIO CLIENTE que fecha a conexão ao processar essa mensagem
            // (ver ChatService), garantindo que a entrega já aconteceu antes de
            // qualquer coisa fechar.
            await Clients.Caller.SendAsync("JoinRejected", "Nome de usuário inválido.");
            return;
        }

        // O nome de usuário funciona como identidade única no sistema inteiro:
        // é como o SignalR endereça mensagem privada (Clients.User(nome)) e é o
        // que aparece pra todo mundo saber quem é quem. Duas conexões com o
        // mesmo nome ficam indistinguíveis (a presença no Redis conta por nome,
        // não por conexão), então recusa a segunda tentativa de entrar com um
        // nome já em uso agora, igual todo chat de verdade faz. Existe uma
        // corrida estreita aqui (duas pessoas entrando com o mesmo nome bem no
        // mesmo instante podem ambas passar por essa checagem antes de
        // qualquer uma ser contada); aceitável pro escopo deste projeto.
        //
        // A pergunta certa é "esse nome pertence a OUTRO cliente?", e não "esse
        // nome aparece na presença?".
        //
        // Tentamos antes pela presença, e depois só pelas réplicas vivas, e as
        // duas versões falhavam no mesmo ponto: quando uma réplica morre de
        // repente, o registro que a pessoa deixou lá continua existindo por
        // alguns segundos, e a reconexão automática dela (que começa na hora)
        // batia nesse próprio registro e era recusada com "esse nome já está em
        // uso". Verificado ao vivo: matando o container com SIGKILL, a pessoa
        // era expulsa de si mesma.
        //
        // O identificador do cliente vem da aba do navegador e sobrevive à
        // reconexão, então reconectar é sempre permitido, e duas pessoas
        // diferentes com o mesmo nome continuam sendo barradas.
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

        // Marca que essa conexão realmente entrou (presença contada, grupos
        // entrados); OnDisconnectedAsync usa isso pra saber se tem alguma
        // presença dela pra remover. Sem essa marca, uma conexão recusada que
        // eventualmente desconecta (o cliente chama stop() sozinho) chamaria
        // RemoveUserAsync mesmo nunca tendo chamado AddUserAsync, decrementando
        // por engano a contagem de uma conexão de verdade com o mesmo nome.
        Context.Items["Joined"] = true;

        // Mandado ANTES de entrar no grupo, pela mesma razao do snapshot do
        // visualizador mais abaixo: assim nao existe janela em que uma mensagem
        // ao vivo chegue antes do historico e acabe sobrescrita quando ele
        // preencher a lista.
        var history = await _history.GetRecentAsync(GeralRoom);
        await Clients.Caller.SendAsync("RoomHistory", history);

        await Groups.AddToGroupAsync(Context.ConnectionId, GeralRoom);

        var onlineUsers = await _presence.AddUserAsync(GeralRoom, userName);
        await _presence.AddUserAsync(_replicaName, userName);

        _logger.LogInformation("[{Replica}] {User} entrou na Sala Geral", _replicaName, userName);

        await Clients.Caller.SendAsync("RoomJoined", onlineUsers);
        // Qual réplica atendeu ESTA conexão. O visualizador já mostra onde todo
        // mundo caiu, mas quem está usando não tem como saber onde caiu a própria
        // conexão, que é justamente o que torna o balanceamento perceptível: ao
        // derrubar uma réplica (docker compose stop backend2), dá pra ver a
        // reconexão trazer um servidor diferente aqui.
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

        // O timestamp é gerado aqui, em UTC, e não já formatado; o navegador de quem
        // recebe é quem aplica o fuso horário local. O container pode estar rodando em
        // um fuso diferente do de quem está usando o chat, então formatar no servidor
        // mostraria a hora errada.
        var timestamp = DateTimeOffset.UtcNow.ToString("o");
        await Clients.Group(GeralRoom).SendAsync("ReceiveMessage", userName, message, _replicaName, timestamp);

        // Guardado depois da entrega, nao antes: se o Redis engasgar aqui, quem
        // esta online ja recebeu a mensagem, e o pior caso vira uma falha no
        // historico e nao uma mensagem que ninguem recebeu.
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
