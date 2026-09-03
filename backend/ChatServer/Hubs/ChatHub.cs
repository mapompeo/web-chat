using ChatServer.Services;
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Hubs;

public class ChatHub : Hub
{
    private readonly ILogger<ChatHub> _logger;
    private readonly IRoomPresenceService _presence;
    private readonly string _replicaName;

    public ChatHub(ILogger<ChatHub> logger, IConfiguration configuration, IRoomPresenceService presence)
    {
        _logger = logger;
        _presence = presence;
        _replicaName = configuration["REPLICA_NAME"] ?? "local";
    }

    public async Task JoinRoom(string roomName, string userName)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, roomName);
        Context.Items["RoomName"] = roomName;
        Context.Items["UserName"] = userName;

        var onlineUsers = await _presence.AddUserAsync(roomName, userName);

        _logger.LogInformation("[{Replica}] {User} entrou na sala {Room}", _replicaName, userName, roomName);

        await Clients.Caller.SendAsync("RoomJoined", onlineUsers);
        await Clients.OthersInGroup(roomName).SendAsync("UserJoined", userName, _replicaName);
    }

    public async Task SendMessage(string roomName, string userName, string message)
    {
        _logger.LogInformation(
            "[{Replica}] mensagem de {User} na sala {Room}: {Message}",
            _replicaName, userName, roomName, message);

        await Clients.Group(roomName).SendAsync("ReceiveMessage", userName, message, _replicaName);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("RoomName", out var roomObj) && roomObj is string roomName &&
            Context.Items.TryGetValue("UserName", out var userObj) && userObj is string userName)
        {
            await _presence.RemoveUserAsync(roomName, userName);

            _logger.LogInformation("[{Replica}] {User} saiu da sala {Room}", _replicaName, userName, roomName);

            await Clients.Group(roomName).SendAsync("UserLeft", userName, _replicaName);
        }

        await base.OnDisconnectedAsync(exception);
    }
}
