using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Services;

public class QueryStringUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection)
    {
        return connection.GetHttpContext()?.Request.Query["user"];
    }
}
