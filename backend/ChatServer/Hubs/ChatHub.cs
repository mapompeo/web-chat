using ChatServer.Services;
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Hubs;

public class ChatHub : Hub
{
    private const string GeralRoom = "Geral";

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
        if (!string.IsNullOrEmpty(userName))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GeralRoom);
            var onlineUsers = await _presence.AddUserAsync(GeralRoom, userName);

            _logger.LogInformation("[{Replica}] {User} entrou na Sala Geral", _replicaName, userName);

            await Clients.Caller.SendAsync("RoomJoined", onlineUsers);
            await Clients.OthersInGroup(GeralRoom).SendAsync("UserJoined", userName, _replicaName);
        }

        await base.OnConnectedAsync();
    }

    public async Task SendMessage(string message)
    {
        var userName = Context.UserIdentifier ?? "desconhecido";

        _logger.LogInformation(
            "[{Replica}] mensagem de {User} na Sala Geral: {Message}",
            _replicaName, userName, message);

        await Clients.Group(GeralRoom).SendAsync("ReceiveMessage", userName, message, _replicaName);
    }

    public async Task SendPrivateMessage(string toUserName, string message)
    {
        var fromUserName = Context.UserIdentifier ?? "desconhecido";

        _logger.LogInformation(
            "[{Replica}] mensagem privada de {From} para {To}: {Message}",
            _replicaName, fromUserName, toUserName, message);

        await Clients.User(toUserName).SendAsync("ReceivePrivateMessage", fromUserName, message, _replicaName);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var userName = Context.UserIdentifier;
        if (!string.IsNullOrEmpty(userName))
        {
            await _presence.RemoveUserAsync(GeralRoom, userName);

            _logger.LogInformation("[{Replica}] {User} saiu da Sala Geral", _replicaName, userName);

            await Clients.Group(GeralRoom).SendAsync("UserLeft", userName, _replicaName);
        }

        await base.OnDisconnectedAsync(exception);
    }
}
