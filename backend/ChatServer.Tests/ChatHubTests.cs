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
    public async Task OnConnectedAsync_AddsCallerToGeral_AndSendsCurrentOnlineUsers()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string> { "Ana", "Bob" });
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        groups.Verify(g => g.AddToGroupAsync("conn-1", "Geral", It.IsAny<CancellationToken>()), Times.Once);
        callerProxy.Verify(
            c => c.SendCoreAsync(
                "RoomJoined",
                It.Is<object[]>(a => ((List<string>)a[0]!).Contains("Bob")),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task OnConnectedAsync_TellsCallerWhichReplicaAnsweredTheConnection()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()))
            .ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Groups = Mock.Of<IGroupManager>(),
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        // O nome vem da configuração REPLICA_NAME (ver BuildConfig), que em
        // produção é definida por réplica no docker-compose.yml.
        callerProxy.Verify(
            c => c.SendCoreAsync(
                "ConnectedToReplica",
                It.Is<object[]>(a => (string)a[0]! == "test-replica"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task OnConnectedAsync_WithNoUserIdentifier_RejectsJoin_AndDoesNotJoinOrNotify()
    {
        var presence = new Mock<IRoomPresenceService>();
        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);

        var context = new FakeHubCallerContext("conn-1", null);
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = context
        };

        await hub.OnConnectedAsync();

        // Não chama Context.Abort() de propósito, ver comentário em
        // ChatHub.OnConnectedAsync sobre a corrida entre SendAsync e Abort().
        Assert.False(((FakeHubCallerContext)hub.Context).WasAborted);
        Assert.False(context.Items.ContainsKey("Joined"));
        groups.Verify(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never());
        callerProxy.Verify(
            c => c.SendCoreAsync("JoinRejected", It.IsAny<object[]>(), It.IsAny<CancellationToken>()),
            Times.Once);
        clients.Verify(c => c.OthersInGroup(It.IsAny<string>()), Times.Never());
        presence.Verify(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never());
        presence.Verify(p => p.GetUsersAsync(It.IsAny<string>()), Times.Never());
    }

    [Fact]
    public async Task OnConnectedAsync_WithNameAlreadyTaken_RejectsJoin_AndDoesNotJoinOrNotify()
    {
        // O nome pertence a OUTRO cliente, entao a reserva falha.
        var presence = new Mock<IRoomPresenceService>();
        var names = new Mock<INameOwnershipService>();
        names.Setup(n => n.TryClaimAsync("Geral", "Ana", It.IsAny<string>())).ReturnsAsync(false);

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);

        var context = new FakeHubCallerContext("conn-2", "Ana");
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), names.Object)
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = context
        };

        await hub.OnConnectedAsync();

        Assert.False(((FakeHubCallerContext)hub.Context).WasAborted);
        Assert.False(context.Items.ContainsKey("Joined"));
        callerProxy.Verify(
            c => c.SendCoreAsync("JoinRejected", It.IsAny<object[]>(), It.IsAny<CancellationToken>()),
            Times.Once);
        groups.Verify(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never());
        presence.Verify(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never());
    }

    [Fact]
    public async Task OnDisconnectedAsync_ForConnectionThatWasNeverJoined_DoesNotTouchPresence()
    {
        // Simula o disconnect eventual de uma conexão que foi recusada em
        // OnConnectedAsync (nome já em uso, por exemplo); ela nunca chamou
        // AddUserAsync nem entrou em nenhum grupo, então o disconnect dela não
        // pode decrementar a presença de ninguém.
        var presence = new Mock<IRoomPresenceService>();
        var clients = new Mock<IHubCallerClients>();

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-rejected", "Ana")
        };

        await hub.OnDisconnectedAsync(null);

        presence.Verify(p => p.RemoveUserAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never());
        clients.Verify(c => c.Group(It.IsAny<string>()), Times.Never());
    }

    [Fact]
    public async Task OnConnectedAsync_AlsoTracksPresenceByReplicaName()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        presence.Verify(p => p.AddUserAsync("test-replica", "Ana"), Times.Once);
    }

    [Fact]
    public async Task OnConnectedAsync_SendsVisualizerSnapshot_AndBroadcastsConnected()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync("Geral", "Ana")).ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync("Geral")).ReturnsAsync(new List<string>());
        presence.Setup(p => p.GetUsersAsync("Servidor A")).ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync("Servidor B")).ReturnsAsync(new List<string>());
        presence.Setup(p => p.GetUsersAsync("Servidor C")).ReturnsAsync(new List<string>());

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var othersVisualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup("Geral")).Returns(Mock.Of<IClientProxy>());
        clients.Setup(c => c.OthersInGroup("Visualizador")).Returns(othersVisualizerProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        groups.Verify(g => g.AddToGroupAsync("conn-1", "Visualizador", It.IsAny<CancellationToken>()), Times.Once);

        callerProxy.Verify(
            c => c.SendCoreAsync(
                "VisualizerSnapshot",
                It.Is<object[]>(a =>
                    ((Dictionary<string, string[]>)a[0]!)["Servidor A"].Contains("Ana") &&
                    ((Dictionary<string, string[]>)a[0]!)["Servidor B"].Length == 0 &&
                    ((Dictionary<string, string[]>)a[0]!)["Servidor C"].Length == 0),
                It.IsAny<CancellationToken>()),
            Times.Once);

        othersVisualizerProxy.Verify(
            c => c.SendCoreAsync(
                "VisualizerUserConnected",
                It.Is<object[]>(a => (string)a[0]! == "test-replica" && (string)a[1]! == "Ana"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendMessage_BroadcastsToGeralGroup()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>())).ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendMessage("oi pessoal");

        groupProxy.Verify(
            p => p.SendCoreAsync(
                "ReceiveMessage",
                It.Is<object[]>(a =>
                    a.Length == 4 &&
                    (string)a[0]! == "Ana" &&
                    (string)a[1]! == "oi pessoal" &&
                    (string)a[2]! == "test-replica" &&
                    !string.IsNullOrEmpty((string)a[3]!)),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendMessage_BroadcastsVisualizerGeralMessage_WithActiveReplicas()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync("Servidor A")).ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync("Servidor B")).ReturnsAsync(new List<string>());
        presence.Setup(p => p.GetUsersAsync("Servidor C")).ReturnsAsync(new List<string> { "Carla" });

        var groupProxy = new Mock<IClientProxy>();
        var visualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(visualizerProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendMessage("oi pessoal");

        visualizerProxy.Verify(
            p => p.SendCoreAsync(
                "VisualizerGeralMessage",
                It.Is<object[]>(a =>
                    (string)a[0]! == "test-replica" &&
                    (string)a[1]! == "Ana" &&
                    ((string[])a[2]!).Contains("Servidor A") &&
                    ((string[])a[2]!).Contains("Servidor C") &&
                    !((string[])a[2]!).Contains("Servidor B")),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendPrivateMessage_DeliversOnlyToTargetUser()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>())).ReturnsAsync(new List<string>());

        var targetProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.User("Bob")).Returns(targetProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendPrivateMessage("Bob", "oi Bob, so pra voce");

        targetProxy.Verify(
            p => p.SendCoreAsync(
                "ReceivePrivateMessage",
                It.Is<object[]>(a =>
                    a.Length == 4 &&
                    (string)a[0]! == "Ana" &&
                    (string)a[1]! == "oi Bob, so pra voce" &&
                    (string)a[2]! == "test-replica" &&
                    !string.IsNullOrEmpty((string)a[3]!)),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendPrivateMessage_BroadcastsVisualizerPrivateMessage_WithoutAnyNames()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync("Servidor A")).ReturnsAsync(new List<string>());
        presence.Setup(p => p.GetUsersAsync("Servidor B")).ReturnsAsync(new List<string> { "Bob" });
        presence.Setup(p => p.GetUsersAsync("Servidor C")).ReturnsAsync(new List<string>());

        var targetProxy = new Mock<IClientProxy>();
        var visualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.User("Bob")).Returns(targetProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(visualizerProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendPrivateMessage("Bob", "oi Bob, so pra voce");

        // Garante, com contagem exata de campos, que o payload NUNCA carrega nome
        // nem conteúdo de mensagem privada de terceiros, só nomes de réplica.
        visualizerProxy.Verify(
            p => p.SendCoreAsync(
                "VisualizerPrivateMessage",
                It.Is<object[]>(a =>
                    a.Length == 2 &&
                    (string)a[0]! == "test-replica" &&
                    ((string[])a[1]!).Contains("Servidor B")),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_RemovesPresence_AndNotifiesGeral()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string> { "Bob" });
        presence.Setup(p => p.RemoveUserAsync("test-replica", "Ana"))
            .ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(Mock.Of<IClientProxy>());

        var context = new FakeHubCallerContext("conn-1", "Ana");
        context.Items["Joined"] = true;
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = context
        };

        await hub.OnDisconnectedAsync(null);

        presence.Verify(p => p.RemoveUserAsync("Geral", "Ana"), Times.Once);
        groupProxy.Verify(
            p => p.SendCoreAsync(
                "UserLeft",
                It.Is<object[]>(a => (string)a[0]! == "Ana"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_AlsoRemovesPresenceByReplicaName()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string>());
        presence.Setup(p => p.RemoveUserAsync("test-replica", "Ana"))
            .ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(groupProxy.Object);

        var context = new FakeHubCallerContext("conn-1", "Ana");
        context.Items["Joined"] = true;
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = context
        };

        await hub.OnDisconnectedAsync(null);

        presence.Verify(p => p.RemoveUserAsync("test-replica", "Ana"), Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_BroadcastsVisualizerUserDisconnected()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana")).ReturnsAsync(new List<string>());
        presence.Setup(p => p.RemoveUserAsync("test-replica", "Ana")).ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var visualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(visualizerProxy.Object);

        var context = new FakeHubCallerContext("conn-1", "Ana");
        context.Items["Joined"] = true;
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = context
        };

        await hub.OnDisconnectedAsync(null);

        visualizerProxy.Verify(
            p => p.SendCoreAsync(
                "VisualizerUserDisconnected",
                It.Is<object[]>(a => (string)a[0]! == "test-replica" && (string)a[1]! == "Ana"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_DoesNotBroadcastVisualizerUserDisconnected_WhenUserStillHasAnotherConnectionOnSameReplica()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana")).ReturnsAsync(new List<string> { "Ana" });
        // Simula uma segunda aba de Ana ainda conectada na mesma replica: a lista pos-remocao
        // ainda contem "Ana".
        presence.Setup(p => p.RemoveUserAsync("test-replica", "Ana")).ReturnsAsync(new List<string> { "Ana" });

        var groupProxy = new Mock<IClientProxy>();
        var visualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(visualizerProxy.Object);

        var context = new FakeHubCallerContext("conn-1", "Ana");
        context.Items["Joined"] = true;
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), FreeNames())
        {
            Clients = clients.Object,
            Context = context
        };

        await hub.OnDisconnectedAsync(null);

        visualizerProxy.Verify(
            p => p.SendCoreAsync(
                "VisualizerUserDisconnected",
                It.IsAny<object[]>(),
                It.IsAny<CancellationToken>()),
            Times.Never);
    }

    [Fact]
    public async Task OnConnectedAsync_WhenTheSameClientReconnects_AllowsTheJoinEvenWithTheNameTaken()
    {
        // O caso que motivou a posse de nome. A réplica que a Ana usava morreu
        // de repente e o registro dela continua lá por alguns segundos. A
        // reconexão automática chega aqui com o MESMO identificador de aba, e
        // não pode ser recusada: aquele registro é dela própria. Antes disso,
        // matar uma réplica expulsava de vez quem estava nela.
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()))
            .ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        // A reserva devolve true porque o nome já era deste mesmo cliente.
        var names = new Mock<INameOwnershipService>();
        names.Setup(n => n.TryClaimAsync("Geral", "Ana", It.IsAny<string>())).ReturnsAsync(true);

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var context = new FakeHubCallerContext("conn-nova", "Ana");
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), Mock.Of<IMessageHistoryService>(), names.Object)
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = context
        };

        await hub.OnConnectedAsync();

        Assert.True(context.Items.ContainsKey("Joined"));
        callerProxy.Verify(
            c => c.SendCoreAsync("JoinRejected", It.IsAny<object[]>(), It.IsAny<CancellationToken>()),
            Times.Never());
        groups.Verify(g => g.AddToGroupAsync("conn-nova", "Geral", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task OnConnectedAsync_SendsRecentHistoryToTheCaller()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()))
            .ReturnsAsync(new List<string> { "Ana" });
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var history = new Mock<IMessageHistoryService>();
        history.Setup(h => h.GetRecentAsync("Geral")).ReturnsAsync(new List<StoredMessage>
        {
            new("Bob", "oi", "Servidor B", "2026-01-01T00:00:00.000Z")
        });

        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), history.Object, FreeNames())
        {
            Groups = Mock.Of<IGroupManager>(),
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        callerProxy.Verify(
            c => c.SendCoreAsync(
                "RoomHistory",
                It.Is<object[]>(a => ((IReadOnlyList<StoredMessage>)a[0]!).Single().Message == "oi"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendMessage_StoresTheMessageInTheHistory()
    {
        var history = new Mock<IMessageHistoryService>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), history.Object, FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendMessage("bom dia");

        history.Verify(
            h => h.AddAsync("Geral", It.Is<StoredMessage>(m =>
                m.UserName == "Ana" && m.Message == "bom dia" && m.Replica == "test-replica")),
            Times.Once);
    }

    [Fact]
    public async Task SendPrivateMessage_DoesNotStoreAnythingInTheHistory()
    {
        // Conversa privada fica de fora do histórico de propósito: guardar
        // conteúdo endereçado a uma pessoa específica é outra decisão, com
        // outras implicações, e o projeto trata mensagem privada como anônima
        // até no visualizador.
        var history = new Mock<IMessageHistoryService>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.User(It.IsAny<string>())).Returns(Mock.Of<ISingleClientProxy>());
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.GetUsersAsync(It.IsAny<string>()))
            .ReturnsAsync(new List<string>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object, AllReplicasAlive(), history.Object, FreeNames())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendPrivateMessage("Bob", "segredo");

        history.Verify(
            h => h.AddAsync(It.IsAny<string>(), It.IsAny<StoredMessage>()),
            Times.Never());
    }

    // Por padrão o nome pedido está livre. Quem testa a recusa monta o próprio
    // mock devolvendo false.
    private static INameOwnershipService FreeNames()
    {
        var names = new Mock<INameOwnershipService>();
        names.Setup(n => n.TryClaimAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>()))
            .ReturnsAsync(true);
        return names.Object;
    }

    // Por padrão os testes rodam com todas as réplicas vivas, que é o estado
    // normal. Quem precisa simular uma réplica caída monta o próprio mock.
    private static IReplicaRegistry AllReplicasAlive()
    {
        var registry = new Mock<IReplicaRegistry>();
        registry.Setup(r => r.GetAliveAsync(It.IsAny<IEnumerable<string>>()))
            .ReturnsAsync((IEnumerable<string> nomes) => nomes.ToList());
        return registry.Object;
    }

    private static IConfiguration BuildConfig() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["REPLICA_NAME"] = "test-replica"
        }).Build();

    private class FakeHubCallerContext : HubCallerContext
    {
        public override string ConnectionId { get; }
        public override string? UserIdentifier { get; }
        public override ClaimsPrincipal? User => null;
        public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
        public override IFeatureCollection Features { get; } = new FeatureCollection();
        public override CancellationToken ConnectionAborted => CancellationToken.None;
        public bool WasAborted { get; private set; }
        public override void Abort() { WasAborted = true; }

        public FakeHubCallerContext(string connectionId, string? userIdentifier)
        {
            ConnectionId = connectionId;
            UserIdentifier = userIdentifier;
        }
    }
}
