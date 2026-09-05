# Visualizador de Arquitetura Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um painel lateral, sempre visível ao lado do chat, mostrando os 3 servidores backend, o Nginx e o Redis, com avatares de quem está conectado em cada servidor e pulsos animados representando conexões, desconexões e mensagens em tempo real.

**Architecture:** O backend reaproveita 100% do `IRoomPresenceService` já existente (tratando cada réplica como mais uma "sala"), acrescenta um método de leitura pura (`GetUsersAsync`) e um novo grupo SignalR (`"Visualizador"`) na mesma conexão do chat, que recebe eventos leves de connect/disconnect/mensagem. O frontend guarda esse estado em novos sinais no `ChatService` já existente e desenha o diagrama num componente Angular novo, usando SVG inline (sem lib de diagramação) e reaproveitando o `AvatarService` já existente.

**Tech Stack:** ASP.NET Core / SignalR (backend, já existente), Angular 22 + Signals (frontend, já existente), Redis (já existente) — nenhuma dependência nova.

**Spec:** `docs/superpowers/specs/2026-09-05-visualizador-arquitetura-design.md`

## Global Constraints

- A topologia é sempre fixa: exatamente 3 réplicas, nomeadas `"Servidor A"`, `"Servidor B"`, `"Servidor C"` (mesmos valores das variáveis `REPLICA_NAME` no `docker-compose.yml`).
- O evento `VisualizerPrivateMessage` **nunca** carrega nome de usuário nem conteúdo de mensagem — só nomes de réplica. Isso é verificado explicitamente em teste (contagem exata de campos no payload), não só por convenção de exibição.
- Nenhuma dependência nova de biblioteca de ícones ou de diagramação — ícones em SVG inline, no próprio código.
- Avatares reaproveitam o `AvatarService` já existente (DiceBear, gerado localmente, determinístico por nome) — mesma pessoa, mesmo desenho, em qualquer lugar do app.
- Nenhuma lógica Redis nova é escrita — toda a presença por réplica reaproveita o `IRoomPresenceService` já existente e testado sob estresse.
- O painel começa aberto por padrão, com um botão pra esconder/mostrar.

---

### Task 1: Presença por réplica no ChatHub

**Files:**
- Modify: `backend/ChatServer/Hubs/ChatHub.cs:21-43` (`OnConnectedAsync`), `:73-86` (`OnDisconnectedAsync`)
- Test: `backend/ChatServer.Tests/ChatHubTests.cs`

**Interfaces:**
- Consumes: `IRoomPresenceService.AddUserAsync(string roomName, string userName): Task<IReadOnlyList<string>>` e `RemoveUserAsync(string roomName, string userName): Task<IReadOnlyList<string>>` (já existem hoje, sem mudança de assinatura).
- Produces: nenhuma interface nova — só um efeito colateral a mais no `ChatHub` (a presença passa a ser rastreada também com o nome da réplica como "sala").

- [ ] **Step 1: Escrever os testes que falham**

Adicione estes dois testes ao final da classe `ChatHubTests`, antes do método `BuildConfig()`:

```csharp
    [Fact]
    public async Task OnConnectedAsync_AlsoTracksPresenceByReplicaName()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.AddUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string> { "Ana" });

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnConnectedAsync();

        presence.Verify(p => p.AddUserAsync("test-replica", "Ana"), Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_AlsoRemovesPresenceByReplicaName()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana"))
            .ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(groupProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnDisconnectedAsync(null);

        presence.Verify(p => p.RemoveUserAsync("test-replica", "Ana"), Times.Once);
    }
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `cd backend && dotnet test --filter "OnConnectedAsync_AlsoTracksPresenceByReplicaName|OnDisconnectedAsync_AlsoRemovesPresenceByReplicaName"`
Expected: FAIL — `presence.Verify(...)` acusa 0 chamadas em vez de 1, porque o `ChatHub` ainda não chama `AddUserAsync`/`RemoveUserAsync` com o nome da réplica.

- [ ] **Step 3: Implementar**

Em `ChatHub.cs`, no `OnConnectedAsync`, logo depois da linha `var onlineUsers = await _presence.AddUserAsync(GeralRoom, userName);`, adicione:

```csharp
        await _presence.AddUserAsync(_replicaName, userName);
```

No `OnDisconnectedAsync`, logo depois da linha `await _presence.RemoveUserAsync(GeralRoom, userName);`, adicione:

```csharp
            await _presence.RemoveUserAsync(_replicaName, userName);
```

- [ ] **Step 4: Rodar todos os testes e confirmar que passam**

Run: `cd backend && dotnet test`
Expected: PASS — todos os 7 testes (5 já existentes + 2 novos).

- [ ] **Step 5: Commit**

```bash
git add backend/ChatServer/Hubs/ChatHub.cs backend/ChatServer.Tests/ChatHubTests.cs
git commit -m "feat: rastreia presenca tambem por nome de replica"
```

---

### Task 2: Eventos do visualizador no ChatHub

**Files:**
- Modify: `backend/ChatServer/Services/IRoomPresenceService.cs`
- Modify: `backend/ChatServer/Services/RedisRoomPresenceService.cs`
- Modify: `backend/ChatServer/Hubs/ChatHub.cs` (arquivo inteiro, substituído abaixo)
- Test: `backend/ChatServer.Tests/ChatHubTests.cs` (arquivo inteiro, substituído abaixo)

**Interfaces:**
- Consumes: a presença por réplica da Task 1.
- Produces: `IRoomPresenceService.GetUsersAsync(string roomName): Task<IReadOnlyList<string>>` (novo, público); eventos SignalR `VisualizerSnapshot(Dictionary<string,string[]>)`, `VisualizerUserConnected(string replica, string userName)`, `VisualizerUserDisconnected(string replica, string userName)`, `VisualizerGeralMessage(string fromReplica, string userName, string[] activeReplicas)`, `VisualizerPrivateMessage(string fromReplica, string[] toReplicas)` — consumidos pelo frontend na Task 3.

- [ ] **Step 1: Escrever os testes que falham**

Primeiro, adicione o método novo à interface **e** torne público o método
equivalente em `RedisRoomPresenceService` — as duas mudanças precisam ir
juntas neste mesmo passo, senão a solução para de compilar entre um passo e
outro (a classe deixaria de implementar a interface assim que o método novo
fosse adicionado só nela). Nenhuma das duas é "a implementação sob teste"
aqui — só o comportamento novo do `ChatHub` (Step 3) é.

Conteúdo final de `IRoomPresenceService.cs`:

```csharp
namespace ChatServer.Services;

public interface IRoomPresenceService
{
    Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName);
    Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName);
    Task<IReadOnlyList<string>> GetUsersAsync(string roomName);
}
```

Em `RedisRoomPresenceService.cs`, troque a assinatura do método privado
`GetUsersAsync` pra pública (o corpo do método não muda):

```csharp
    public async Task<IReadOnlyList<string>> GetUsersAsync(string roomName)
```

Agora substitua **o arquivo inteiro** `backend/ChatServer.Tests/ChatHubTests.cs` por este conteúdo (ele já inclui os 7 testes anteriores — 3 deles precisaram ganhar mocks novos porque o código que vamos escrever no Step 3 passa a chamar `Clients.Group("Visualizador")`/`Clients.OthersInGroup("Visualizador")`/`presence.GetUsersAsync(...)` em todo `OnConnectedAsync`, `SendMessage`, `SendPrivateMessage` e `OnDisconnectedAsync` — sem esses mocks, os testes antigos quebrariam com `NullReferenceException` em vez de passar):

```csharp
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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
    public async Task OnConnectedAsync_WithNoUserIdentifier_AbortsConnection_AndDoesNotJoinOrNotify()
    {
        var presence = new Mock<IRoomPresenceService>();
        var groups = new Mock<IGroupManager>();
        var clients = new Mock<IHubCallerClients>();

        var context = new FakeHubCallerContext("conn-1", null);
        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Groups = groups.Object,
            Clients = clients.Object,
            Context = context
        };

        await hub.OnConnectedAsync();

        Assert.True(((FakeHubCallerContext)hub.Context).WasAborted);
        groups.Verify(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never());
        clients.Verify(c => c.Caller, Times.Never());
        clients.Verify(c => c.OthersInGroup(It.IsAny<string>()), Times.Never());
        presence.Verify(p => p.AddUserAsync(It.IsAny<string>(), It.IsAny<string>()), Times.Never());
        presence.Verify(p => p.GetUsersAsync(It.IsAny<string>()), Times.Never());
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
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

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendPrivateMessage("Bob", "oi Bob, so pra voce");

        // Garante, com contagem exata de campos, que o payload NUNCA carrega nome
        // nem conteúdo de mensagem privada de terceiros — só nomes de réplica.
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

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(Mock.Of<IClientProxy>());

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
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

        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group(It.IsAny<string>())).Returns(groupProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnDisconnectedAsync(null);

        presence.Verify(p => p.RemoveUserAsync("test-replica", "Ana"), Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_BroadcastsVisualizerUserDisconnected()
    {
        var presence = new Mock<IRoomPresenceService>();
        presence.Setup(p => p.RemoveUserAsync("Geral", "Ana")).ReturnsAsync(new List<string>());

        var groupProxy = new Mock<IClientProxy>();
        var visualizerProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);
        clients.Setup(c => c.Group("Visualizador")).Returns(visualizerProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), presence.Object)
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.OnDisconnectedAsync(null);

        visualizerProxy.Verify(
            p => p.SendCoreAsync(
                "VisualizerUserDisconnected",
                It.Is<object[]>(a => (string)a[0]! == "test-replica" && (string)a[1]! == "Ana"),
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
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `cd backend && dotnet test`
Expected: FAIL — os testes novos (`OnConnectedAsync_SendsVisualizerSnapshot_AndBroadcastsConnected`,
`SendMessage_BroadcastsVisualizerGeralMessage_WithActiveReplicas`,
`SendPrivateMessage_BroadcastsVisualizerPrivateMessage_WithoutAnyNames`,
`OnDisconnectedAsync_BroadcastsVisualizerUserDisconnected`) falham porque o `ChatHub` ainda não manda esses eventos. Os testes antigos continuam passando (só ganharam mocks extras que ainda não são exercitados).

- [ ] **Step 3: Implementar**

(`IRoomPresenceService.cs` e `RedisRoomPresenceService.cs` já foram ajustados no Step 1 — eram pré-requisito de compilação, não comportamento sob teste.)

Substitua **o arquivo inteiro** `backend/ChatServer/Hubs/ChatHub.cs` por este conteúdo:

```csharp
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
            Context.Abort();
            return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, GeralRoom);
        await Groups.AddToGroupAsync(Context.ConnectionId, VisualizerGroup);

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
        await Clients.Caller.SendAsync("VisualizerSnapshot", snapshot);
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
        if (!string.IsNullOrEmpty(userName))
        {
            await _presence.RemoveUserAsync(GeralRoom, userName);
            await _presence.RemoveUserAsync(_replicaName, userName);

            _logger.LogInformation("[{Replica}] {User} saiu da Sala Geral", _replicaName, userName);

            await Clients.Group(GeralRoom).SendAsync("UserLeft", userName, _replicaName);
            await Clients.Group(VisualizerGroup).SendAsync("VisualizerUserDisconnected", _replicaName, userName);
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
```

- [ ] **Step 4: Rodar todos os testes e confirmar que passam**

Run: `cd backend && dotnet test`
Expected: PASS — todos os 11 testes.

- [ ] **Step 5: Commit**

```bash
git add backend/ChatServer/Services/IRoomPresenceService.cs backend/ChatServer/Services/RedisRoomPresenceService.cs backend/ChatServer/Hubs/ChatHub.cs backend/ChatServer.Tests/ChatHubTests.cs
git commit -m "feat: eventos do visualizador de arquitetura no ChatHub"
```

---

### Task 3: Estado do visualizador no ChatService

**Files:**
- Modify: `frontend/src/app/services/chat.service.ts` (arquivo inteiro, substituído abaixo)

**Interfaces:**
- Consumes: eventos SignalR `VisualizerSnapshot`, `VisualizerUserConnected`, `VisualizerUserDisconnected`, `VisualizerGeralMessage`, `VisualizerPrivateMessage` (produzidos na Task 2).
- Produces: `ChatService.replicaUsers: Signal<Map<string, string[]>>`, `ChatService.visualizerPulses: Signal<VisualizerPulse[]>`, interface `VisualizerPulse` (exportada, consumida pela Task 4).

Este projeto não tem framework de teste unitário configurado pro Angular (verificado: nenhum `*.spec.ts` existe hoje) — a verificação estabelecida no projeto inteiro até aqui é `ng build` (checagem de tipos) seguido de teste ao vivo com o navegador. Este padrão continua aqui.

- [ ] **Step 1: Implementar**

Substitua **o arquivo inteiro** `frontend/src/app/services/chat.service.ts` por este conteúdo:

```typescript
import { Injectable, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';

export interface ChatMessage {
  userName: string;
  message: string;
  replica: string;
  timestamp: string;
}

export interface VisualizerPulse {
  id: string;
  kind: 'connect' | 'disconnect' | 'geral' | 'privada';
  replica?: string;           // connect/disconnect
  fromReplica?: string;       // geral/privada
  toReplicas?: string[];      // geral (leque) ou privada (pode ter mais de uma réplica)
  userName?: string;          // connect/disconnect/geral — nunca em privada
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  // Duração da animação de cada pulso no painel do visualizador — precisa bater
  // com a duração declarada em @keyframes viz-flow-down/viz-flow-up no styles.scss
  // (Task 4), senão o pulso some da tela antes (ou depois) da animação acabar.
  private static readonly PULSE_DURATION_MS = 1400;

  private connection?: signalR.HubConnection;

  readonly currentUserName = signal<string>('');
  readonly onlineUsers = signal<string[]>([]);
  readonly geralMessages = signal<ChatMessage[]>([]);
  readonly privateMessages = signal<Map<string, ChatMessage[]>>(new Map());
  readonly unreadPrivate = signal<Set<string>>(new Set());
  readonly replicaUsers = signal<Map<string, string[]>>(new Map());
  readonly visualizerPulses = signal<VisualizerPulse[]>([]);

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  async connect(userName: string): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
    }

    this.currentUserName.set(userName);
    this.geralMessages.set([]);
    this.onlineUsers.set([]);
    this.privateMessages.set(new Map());
    this.unreadPrivate.set(new Set());
    this.replicaUsers.set(new Map());
    this.visualizerPulses.set([]);

    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente — a segunda
      // rejeita a conexão porque o connectionId só existe na réplica que negociou.
      // Pulando a negociação, a conexão vira uma única requisição atômica.
      .withUrl(`/chatHub?user=${encodeURIComponent(userName)}`, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets
      })
      .withAutomaticReconnect()
      .build();

    this.connection.on('RoomJoined', (users: string[]) => {
      this.onlineUsers.set(users);
    });

    this.connection.on('UserJoined', (joinedUser: string) => {
      this.onlineUsers.update(users => users.includes(joinedUser) ? users : [...users, joinedUser]);
    });

    this.connection.on('UserLeft', (leftUser: string) => {
      this.onlineUsers.update(users => users.filter(u => u !== leftUser));
    });

    this.connection.on('ReceiveMessage', (fromUser: string, message: string, replica: string, timestamp: string) => {
      this.geralMessages.update(msgs => [...msgs, { userName: fromUser, message, replica, timestamp }]);
    });

    this.connection.on('ReceivePrivateMessage', (fromUser: string, message: string, replica: string, timestamp: string) => {
      this.privateMessages.update(map => {
        const next = new Map(map);
        const existing = next.get(fromUser) ?? [];
        next.set(fromUser, [...existing, { userName: fromUser, message, replica, timestamp }]);
        return next;
      });
      // Marca como não lida sempre — quem estiver com a conversa aberta na hora
      // limpa isso de volta imediatamente (ver efeito em ChatRoomComponent), então
      // na prática só fica marcado quem realmente não está olhando aquela conversa.
      this.unreadPrivate.update(set => new Set(set).add(fromUser));
    });

    this.connection.on('VisualizerSnapshot', (snapshot: Record<string, string[]>) => {
      this.replicaUsers.set(new Map(Object.entries(snapshot)));
    });

    this.connection.on('VisualizerUserConnected', (replica: string, connectedUser: string) => {
      this.replicaUsers.update(map => {
        const next = new Map(map);
        const users = next.get(replica) ?? [];
        if (!users.includes(connectedUser)) {
          next.set(replica, [...users, connectedUser]);
        }
        return next;
      });
      this.addPulse({ kind: 'connect', replica, userName: connectedUser });
    });

    this.connection.on('VisualizerUserDisconnected', (replica: string, disconnectedUser: string) => {
      this.replicaUsers.update(map => {
        const next = new Map(map);
        const users = next.get(replica) ?? [];
        next.set(replica, users.filter(u => u !== disconnectedUser));
        return next;
      });
      this.addPulse({ kind: 'disconnect', replica, userName: disconnectedUser });
    });

    this.connection.on('VisualizerGeralMessage', (fromReplica: string, geralUser: string, activeReplicas: string[]) => {
      this.addPulse({ kind: 'geral', fromReplica, toReplicas: activeReplicas, userName: geralUser });
    });

    this.connection.on('VisualizerPrivateMessage', (fromReplica: string, toReplicas: string[]) => {
      this.addPulse({ kind: 'privada', fromReplica, toReplicas });
    });

    await this.connection.start();
  }

  markPrivateRead(userName: string): void {
    this.unreadPrivate.update(set => {
      if (!set.has(userName)) return set;
      const next = new Set(set);
      next.delete(userName);
      return next;
    });
  }

  async sendMessage(message: string): Promise<void> {
    await this.connection?.invoke('SendMessage', message);
  }

  async sendPrivateMessage(toUserName: string, message: string): Promise<void> {
    await this.connection?.invoke('SendPrivateMessage', toUserName, message);

    // O servidor não ecoa a mensagem de volta pra quem manda (só entrega pro
    // destinatário) — um eco não teria como carregar "pra quem eu mandei" de forma
    // inequívoca. Como já sabemos localmente o que mandamos e pra quem, adicionamos
    // na nossa própria conversa assim que o envio é confirmado.
    this.privateMessages.update(map => {
      const next = new Map(map);
      const existing = next.get(toUserName) ?? [];
      next.set(toUserName, [
        ...existing,
        { userName: this.currentUserName(), message, replica: '', timestamp: new Date().toISOString() }
      ]);
      return next;
    });
  }

  private addPulse(pulse: Omit<VisualizerPulse, 'id'>): void {
    const id = `${Date.now()}-${Math.random()}`;
    const fullPulse: VisualizerPulse = { ...pulse, id };
    this.visualizerPulses.update(pulses => [...pulses, fullPulse]);
    setTimeout(() => {
      this.visualizerPulses.update(pulses => pulses.filter(p => p.id !== id));
    }, ChatService.PULSE_DURATION_MS);
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `cd frontend && npx ng build`
Expected: build limpo, sem erros de tipo (o `VisualizerPanelComponent` que vai consumir `VisualizerPulse` só chega na Task 4 — nesta task ainda não há nenhum consumidor, o que é esperado).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/services/chat.service.ts
git commit -m "feat: estado do visualizador (replicaUsers, visualizerPulses) no ChatService"
```

---

### Task 4: Componente `VisualizerPanelComponent`

**Files:**
- Create: `frontend/src/app/components/visualizer-panel/visualizer-panel.component.ts`
- Modify: `frontend/src/styles.scss` (adiciona ao final)

**Interfaces:**
- Consumes: `ChatService.replicaUsers`, `ChatService.visualizerPulses`, `VisualizerPulse` (da Task 3); `AvatarService.getAvatar(userName: string): SafeUrl` (já existe, usado nas mensagens).
- Produces: componente standalone `VisualizerPanelComponent` (seletor `app-visualizer-panel`), consumido pela Task 5.

- [ ] **Step 1: Implementar o componente**

Crie `frontend/src/app/components/visualizer-panel/visualizer-panel.component.ts`:

```typescript
import { Component } from '@angular/core';
import { ChatService, VisualizerPulse } from '../../services/chat.service';
import { AvatarService } from '../../services/avatar.service';

@Component({
  selector: 'app-visualizer-panel',
  standalone: true,
  template: `
    <div class="visualizer-panel">
      <h4>Arquitetura ao vivo</h4>

      <div class="viz-node">
        <div class="viz-node-head">
          <svg class="viz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M12 7v4M12 11 L6 15 M12 11 L18 15"/><circle cx="6" cy="17" r="2"/><circle cx="18" cy="17" r="2"/></svg>
          Nginx
          <span class="viz-count">load balancer</span>
        </div>
      </div>

      <div class="viz-connectors">
        @for (replica of replicaNames; track replica) {
          <div class="viz-lane">
            @for (p of topLanePulses(replica); track p.pulse.id) {
              <div
                class="viz-pulse"
                [class.reverse]="p.direction === 'up'"
                [class.connect]="p.pulse.kind === 'connect'"
                [class.disconnect]="p.pulse.kind === 'disconnect'"
              ></div>
            }
          </div>
        }
      </div>

      <div class="viz-servers">
        @for (replica of replicaNames; track replica) {
          <div class="viz-node">
            <div class="viz-node-head">
              <svg class="viz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/><circle cx="7" cy="7.5" r="0.6" fill="currentColor"/><circle cx="7" cy="16.5" r="0.6" fill="currentColor"/></svg>
              {{ replica }}
              <span class="viz-count">{{ usersIn(replica).length }}</span>
            </div>
            @if (usersIn(replica).length > 0) {
              <div class="viz-people">
                @for (person of usersIn(replica); track person) {
                  <div class="viz-person">
                    <img class="viz-avatar" [src]="avatar.getAvatar(person)" alt="" />
                    <span class="viz-name">{{ person }}</span>
                  </div>
                }
              </div>
            } @else {
              <div class="viz-empty-hint">ninguém conectado</div>
            }
          </div>
        }
      </div>

      <div class="viz-connectors">
        @for (replica of replicaNames; track replica) {
          <div class="viz-lane">
            @for (p of bottomLanePulses(replica); track p.pulse.id + p.direction) {
              <div
                class="viz-pulse"
                [class.reverse]="p.direction === 'up'"
                [class.gray]="p.pulse.kind === 'privada'"
              ></div>
            }
          </div>
        }
      </div>

      <div class="viz-node">
        <div class="viz-node-head">
          <svg class="viz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2Z"/><path d="M4 6v12c0 1.1 3.6 2 8 2s8-.9 8-2V6"/><path d="M4 12c0 1.1 3.6 2 8 2s8-.9 8-2"/></svg>
          Redis
          <span class="viz-count">backplane</span>
        </div>
      </div>
    </div>
  `
})
export class VisualizerPanelComponent {
  // Mesma lista fixa que o backend usa em ChatHub.AllReplicaNames — ver
  // docs/superpowers/specs/2026-09-05-visualizador-arquitetura-design.md
  // pela explicação de por que isso é hardcoded nos dois lados.
  readonly replicaNames = ['Servidor A', 'Servidor B', 'Servidor C'];

  constructor(public chatService: ChatService, public avatar: AvatarService) {}

  usersIn(replica: string): string[] {
    return this.chatService.replicaUsers().get(replica) ?? [];
  }

  topLanePulses(replica: string): { pulse: VisualizerPulse; direction: 'down' | 'up' }[] {
    return this.chatService.visualizerPulses()
      .filter(p => (p.kind === 'connect' || p.kind === 'disconnect') && p.replica === replica)
      .map(p => ({ pulse: p, direction: (p.kind === 'connect' ? 'down' : 'up') as 'down' | 'up' }));
  }

  bottomLanePulses(replica: string): { pulse: VisualizerPulse; direction: 'down' | 'up' }[] {
    const results: { pulse: VisualizerPulse; direction: 'down' | 'up' }[] = [];
    for (const p of this.chatService.visualizerPulses()) {
      if (p.kind !== 'geral' && p.kind !== 'privada') continue;
      if (p.fromReplica === replica) {
        results.push({ pulse: p, direction: 'down' });
      }
      // Uma mensagem geral inclui a própria réplica de quem mandou na lista de
      // destinos (porque o grupo do SignalR entrega de volta pra quem mandou
      // também) — ignoramos esse caso aqui pra não desenhar um pulso "subindo"
      // de volta pro mesmo servidor que acabou de mandar, o que ficaria estranho
      // visualmente mesmo sendo tecnicamente real.
      if (p.toReplicas?.includes(replica) && p.fromReplica !== replica) {
        results.push({ pulse: p, direction: 'up' });
      }
    }
    return results;
  }
}
```

- [ ] **Step 2: Adicionar os estilos**

Adicione ao final de `frontend/src/styles.scss`:

```scss
/* ------------------------------------------------------------------ */
/* Painel do visualizador de arquitetura                               */
/* ------------------------------------------------------------------ */

.visualizer-panel {
  width: 300px;
  flex-shrink: 0;
  height: 100%;
  overflow-y: auto;
  background: var(--surface);
  border-left: 1px solid var(--border);
  padding: 24px 20px;
  display: flex;
  flex-direction: column;

  h4 {
    margin: 0 0 20px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
}

.viz-node {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}

.viz-node-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);

  .viz-icon {
    width: 22px;
    height: 22px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .viz-count {
    margin-left: auto;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--text-muted);
  }
}

.viz-people {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}

.viz-person {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 48px;
}

.viz-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex-shrink: 0;
}

.viz-name {
  font-size: 0.68rem;
  color: var(--text-muted);
  text-align: center;
  max-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.viz-empty-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  font-style: italic;
  opacity: 0.7;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.viz-connectors {
  display: flex;
  gap: 14px;
  height: 36px;
}

.viz-lane {
  flex: 1;
  position: relative;
  border-left: 2px dashed var(--border);
  margin: 0 auto;
  width: 0;
}

.viz-pulse {
  position: absolute;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  animation: viz-flow-down 1.4s ease-in-out;

  &.reverse {
    animation-name: viz-flow-up;
  }

  &.gray,
  &.disconnect {
    background: var(--text-muted);
    box-shadow: 0 0 8px var(--text-muted);
  }

  &.connect {
    background: #4ade80;
    box-shadow: 0 0 8px #4ade80;
  }
}

@keyframes viz-flow-down {
  0% { top: -4px; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

@keyframes viz-flow-up {
  0% { top: 100%; opacity: 0; }
  15% { opacity: 1; }
  85% { opacity: 1; }
  100% { top: -4px; opacity: 0; }
}

.viz-servers {
  display: flex;
  gap: 14px;
  flex: 1;

  .viz-node {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
}
```

- [ ] **Step 3: Verificar que compila**

Run: `cd frontend && npx ng build`
Expected: build limpo. O componente ainda não está referenciado em nenhum lugar do app (isso acontece na Task 5) — `ng build` não reclama de componentes standalone não utilizados, então isso é esperado.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/components/visualizer-panel/visualizer-panel.component.ts frontend/src/styles.scss
git commit -m "feat: componente do painel visual da arquitetura (ainda nao integrado)"
```

---

### Task 5: Integração no layout do chat + botão de esconder/mostrar

**Files:**
- Modify: `frontend/src/app/pages/chat-room/chat-room.component.ts` (arquivo inteiro, substituído abaixo)
- Modify: `frontend/src/styles.scss` (adiciona ao final)

**Interfaces:**
- Consumes: `VisualizerPanelComponent` (Task 4).

- [ ] **Step 1: Implementar**

Substitua **o arquivo inteiro** `frontend/src/app/pages/chat-room/chat-room.component.ts` por este conteúdo:

```typescript
import { Component, OnInit, ViewChild, ElementRef, effect } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatMessage, ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';
import { AvatarService } from '../../services/avatar.service';
import { VisualizerPanelComponent } from '../../components/visualizer-panel/visualizer-panel.component';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule, VisualizerPanelComponent],
  template: `
    <div class="chat-container">
      <aside class="sidebar">
        <h4>Conversas</h4>
        <ul class="conversation-list">
          <li>
            <button
              class="conversation-item"
              [class.active]="activeView === 'geral'"
              (click)="activeView = 'geral'; errorMessage = ''"
            >Sala Geral</button>
          </li>
          @for (user of otherOnlineUsers(); track user) {
            <li>
              <button
                class="conversation-item"
                [class.active]="activeView === user"
                (click)="selectConversation(user)"
              >
                {{ user }}
                @if (chatService.unreadPrivate().has(user)) {
                  <span class="unread-dot" aria-label="Mensagem não lida"></span>
                }
              </button>
            </li>
          }
        </ul>
      </aside>
      <main class="conversation">
        <div class="conversation-header">
          <h3>{{ activeView === 'geral' ? 'Sala Geral' : 'Privado com ' + activeView }}</h3>
          <div class="header-actions">
            <button
              class="theme-toggle"
              type="button"
              (click)="showVisualizer = !showVisualizer"
              [attr.aria-label]="showVisualizer ? 'Esconder visualizador de arquitetura' : 'Mostrar visualizador de arquitetura'"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1rem;height:1rem;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>
            </button>
            <button
              class="theme-toggle"
              type="button"
              (click)="theme.toggle()"
              [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
            >
              <i class="pi" [class.pi-sun]="theme.mode() === 'dark'" [class.pi-moon]="theme.mode() === 'light'"></i>
            </button>
          </div>
        </div>
        @if (errorMessage) {
          <p class="error-text">{{ errorMessage }}</p>
        }
        <ul class="message-list" #messageListEl>
          @for (msg of currentMessages(); track $index) {
            <li class="message-row" [class.mine]="msg.userName === chatService.currentUserName()">
              <img class="avatar" [src]="avatar.getAvatar(msg.userName)" alt="" />
              <div class="message-col">
                <div class="message-info">
                  <strong>{{ msg.userName }}</strong>
                  @if (msg.replica) {
                    <span class="dot">·</span>
                    <span class="replica-tag">{{ msg.replica }}</span>
                  }
                  <span class="dot">·</span>
                  <span class="timestamp">{{ formatTime(msg.timestamp) }}</span>
                </div>
                <p class="message-bubble">{{ msg.message }}</p>
              </div>
            </li>
          }
        </ul>
        <div class="input-row">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
      @if (showVisualizer) {
        <app-visualizer-panel />
      }
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  userName = '';
  draft = '';
  activeView: 'geral' | string = 'geral';
  errorMessage = '';
  showVisualizer = true;

  @ViewChild('messageListEl') messageListEl!: ElementRef<HTMLElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public chatService: ChatService,
    public theme: ThemeService,
    public avatar: AvatarService
  ) {
    // Rola a lista de mensagens pro final sempre que uma nova mensagem chegar
    // (na sala atual ou numa conversa privada) — sem isso, mensagens novas
    // ficam escondidas abaixo da área visível assim que a lista cresce demais.
    // O setTimeout(0) empurra a rolagem pro próximo tick, depois que o Angular
    // já atualizou o DOM com o novo <li>.
    effect(() => {
      this.currentMessages();
      setTimeout(() => {
        const el = this.messageListEl?.nativeElement;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }, 0);
    });

    // Se a conversa que acabou de receber mensagem nova já é a que está aberta na
    // tela, limpa o "não lida" de volta imediatamente — assim a bolinha só aparece
    // pra conversas que a pessoa não está olhando no momento.
    effect(() => {
      const unread = this.chatService.unreadPrivate();
      if (this.activeView !== 'geral' && unread.has(this.activeView)) {
        this.chatService.markPrivateRead(this.activeView);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.userName) {
      this.router.navigate(['/']);
      return;
    }

    if (!this.chatService.isConnected) {
      try {
        await this.chatService.connect(this.userName);
      } catch {
        this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
      }
    }
  }

  selectConversation(user: string): void {
    this.activeView = user;
    this.errorMessage = '';
    this.chatService.markPrivateRead(user);
  }

  otherOnlineUsers(): string[] {
    return this.chatService.onlineUsers().filter(u => u !== this.userName);
  }

  currentMessages(): ChatMessage[] {
    if (this.activeView === 'geral') {
      return this.chatService.geralMessages();
    }
    return this.chatService.privateMessages().get(this.activeView) ?? [];
  }

  formatTime(timestamp: string): string {
    // O servidor manda o horário em UTC — formatamos aqui pra usar o fuso horário
    // local de quem está vendo, já que o container pode rodar em outro fuso.
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  async send(): Promise<void> {
    if (!this.draft.trim()) return;
    const messageToSend = this.draft;
    this.draft = '';
    this.errorMessage = '';

    try {
      if (this.activeView === 'geral') {
        await this.chatService.sendMessage(messageToSend);
      } else {
        await this.chatService.sendPrivateMessage(this.activeView, messageToSend);
      }
    } catch {
      this.errorMessage = 'Não foi possível enviar a mensagem.';
      // só restaura o rascunho se a pessoa não tiver digitado algo novo enquanto
      // o envio falhava — evita atropelar um rascunho mais recente (ver ciclo
      // anterior, revisão final, achado "sobrescrita de draft em corrida rara").
      if (this.draft === '') {
        this.draft = messageToSend;
      }
    }
  }
}
```

- [ ] **Step 2: Adicionar o estilo do agrupador de botões do cabeçalho**

Adicione ao final de `frontend/src/styles.scss`:

```scss
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
```

- [ ] **Step 3: Verificar que compila**

Run: `cd frontend && npx ng build`
Expected: build limpo, sem warning de orçamento de bundle estourado (se estourar, ajuste os valores de `maximumWarning`/`maximumError` em `frontend/angular.json`, igual foi feito quando o avatar do DiceBear foi adicionado).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/pages/chat-room/chat-room.component.ts frontend/src/styles.scss
git commit -m "feat: integra o visualizador de arquitetura no layout do chat"
```

- [ ] **Step 5: Verificação ao vivo (manual)**

Suba o stack com `docker compose up --build -d` e abra pelo menos 2 abas com nomes diferentes (ex: `http://localhost/chat?user=Ana` e `http://localhost/chat?user=Bob`), idealmente numa terceira aba também. Confirme:

- O painel aparece à direita, aberto por padrão, com os 3 servidores, Nginx e Redis.
- Cada aba conectada aparece com avatar (mesmo desenho da lista de mensagens) e nome sob o servidor certo, e some de lá quando a aba fecha.
- Mandar uma mensagem na Sala Geral dispara um pulso saindo do servidor de quem mandou e chegando nos servidores que têm gente conectada.
- Mandar uma mensagem privada de uma aba pra outra dispara um pulso **sem nome nenhum** entre os dois servidores certos.
- O botão de esconder/mostrar o painel funciona nos dois sentidos.

Se algo não bater, ajuste antes de considerar a task concluída — esta é a única verificação de ponta a ponta deste recurso, já que não há teste automatizado de frontend no projeto.
