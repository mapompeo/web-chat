using ChatServer.Hubs;
using ChatServer.Services;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Moq;
using System.Security.Claims;
using Xunit;

namespace ChatServer.Tests;

public class ChatHubTests
{
    [Fact]
    public async Task SendMessage_BroadcastsToRoomGroup()
    {
        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("sala-1")).Returns(groupProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), Mock.Of<IRoomPresenceService>())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1")
        };

        await hub.SendMessage("sala-1", "Ana", "oi pessoal");

        groupProxy.Verify(
            p => p.SendCoreAsync(
                "ReceiveMessage",
                It.Is<object[]>(a => (string)a[0]! == "Ana" && (string)a[1]! == "oi pessoal" && (string)a[2]! == "test-replica"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task JoinRoom_AddsCallerToGroup_AndSendsCurrentOnlineUsers()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync("sala-1", "Ana"))
            .ReturnsAsync(new List<string> { "Ana", "Bob" });

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup("sala-1")).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1")
        };

        await hub.JoinRoom("sala-1", "Ana");

        groups.Verify(g => g.AddToGroupAsync("conn-1", "sala-1", It.IsAny<CancellationToken>()), Times.Once);
        callerProxy.Verify(
            c => c.SendCoreAsync(
                "RoomJoined",
                It.Is<object[]>(a => ((List<string>)a[0]!).Contains("Bob")),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    private static IConfiguration BuildConfig() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["REPLICA_NAME"] = "test-replica"
        }).Build();

    private class FakeHubCallerContext : HubCallerContext
    {
        public override string ConnectionId { get; }
        public override string? UserIdentifier => null;
        public override ClaimsPrincipal? User => null;
        public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
        public override IFeatureCollection Features { get; } = new FeatureCollection();
        public override CancellationToken ConnectionAborted => CancellationToken.None;
        public override void Abort() { }

        public FakeHubCallerContext(string connectionId) => ConnectionId = connectionId;
    }
}
