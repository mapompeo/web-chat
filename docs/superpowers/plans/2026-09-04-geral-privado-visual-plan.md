# Sala Geral, Chat Privado, .NET 10 e Redesign Visual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o modelo de "sala com nome customizado" por uma Sala Geral fixa +
chat privado um-a-um (via entrega direcionada por usuário do SignalR), atualizar o
backend pra .NET 10, e redesenhar o frontend com tema escuro por padrão (estilo
Minimal/Linear) e alternância pra tema claro.

**Architecture:** O chat privado reaproveita o backplane Redis já configurado, mas usa
`Clients.User(...)` do SignalR em vez de grupos/salas — isso exige que a conexão se
identifique (via query string) *no momento de conectar*, não depois. A Sala Geral vira
automática: toda conexão identificada entra nela sozinha, sem chamada explícita de
"entrar".

**Tech Stack:** .NET 10 (ASP.NET Core, SignalR), StackExchange.Redis, xUnit + Moq,
Angular 22 (control flow nativo `@if`/`@for`, sem `CommonModule`), PrimeNG.

**Spec:** `docs/superpowers/specs/2026-09-04-geral-privado-visual-design.md`

## Global Constraints

- .NET 10 (upgrado de .NET 9 — instalar o SDK se não estiver disponível).
- Sala Geral é única e fixa — substitui completamente o modelo de nome de sala
  customizado. Ninguém "entra" nela explicitamente; toda conexão identificada já está
  nela.
- Chat privado não usa salas/grupos — usa `Clients.User(toUserName)`, exige
  `IUserIdProvider` lendo o usuário da query string da conexão (`/chatHub?user=...`).
- Sem histórico de mensagens (Geral ou privado) — mesma filosofia efêmera de sempre.
- Sem autenticação real — "usuário" continua sendo só o nome digitado.
- Tema escuro é o padrão; alternância pra claro precisa persistir no navegador
  (`localStorage`). Paleta exata:
  - Escuro: fundo `#0e0f11`, superfície `#17181b`, borda `#26272b`, texto `#e4e4e7`,
    texto secundário `#a1a1aa`, acento `#5b8cff`.
  - Claro: fundo `#ffffff`, superfície `#f4f4f5`, borda `#e4e4e7`, texto `#18181b`,
    texto secundário `#71717a`, acento `#3b6fe0`.
- Convenção do usuário (global): nunca hardcodar porta de dev server — usar
  `~/scripts/port-for-worktree.sh` antes de `ng serve` local.

---

## Task 1: Atualizar o backend para .NET 10

**Files:**
- Modify: `backend/ChatServer/ChatServer.csproj`
- Modify: `backend/ChatServer.Tests/ChatServer.Tests.csproj`
- Modify: `backend/ChatServer/Dockerfile`

**Interfaces:**
- Consumes: nada (primeira tarefa do ciclo).
- Produces: ambiente de build/execução em `net10.0` que todas as tarefas seguintes
  assumem.

- [ ] **Step 1: Verificar/instalar o SDK do .NET 10**

Run: `dotnet --list-sdks`

Se não aparecer nenhuma versão `10.x`, instale:
```bash
winget install Microsoft.DotNet.SDK.10 --accept-source-agreements --accept-package-agreements
```
Abra um terminal novo (o PATH só atualiza em sessões novas) e confirme de novo com
`dotnet --list-sdks`.

- [ ] **Step 2: Atualizar o target framework dos dois projetos**

`backend/ChatServer/ChatServer.csproj` e `backend/ChatServer.Tests/ChatServer.Tests.csproj`:
troque `<TargetFramework>net9.0</TargetFramework>` por
`<TargetFramework>net10.0</TargetFramework>` (é a única linha que muda em cada arquivo).

- [ ] **Step 3: Atualizar as imagens Docker**

`backend/ChatServer/Dockerfile`: troque `FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build`
por `FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build`, e
`FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime` por
`FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime`.

- [ ] **Step 4: Rodar os testes e confirmar que nada quebrou**

Run: `cd backend && dotnet test`
Expected: os 2 testes existentes continuam passando, agora compilados contra
`net10.0`. Se aparecer erro/warning de compatibilidade, resolva com a mudança mínima
necessária antes de prosseguir (não é esperado nenhuma quebra grande entre .NET 9 e
10 pro que este projeto usa).

- [ ] **Step 5: Confirmar que a imagem Docker builda**

Run: `docker compose build backend1`
Expected: build conclui sem erro, usando as novas imagens `10.0`.

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "chore: atualizar backend para .NET 10"
```

---

## Task 2: Identidade da conexão via query string (IUserIdProvider)

**Files:**
- Create: `backend/ChatServer/Services/QueryStringUserIdProvider.cs`
- Modify: `backend/ChatServer/Program.cs`

**Interfaces:**
- Consumes: nada de novo.
- Produces: a partir de agora, toda conexão SignalR feita com `/chatHub?user=X` tem
  `Context.UserIdentifier == "X"` disponível no Hub — contrato que a Task 3 depende
  diretamente.

- [ ] **Step 1: Implementar o provider**

`backend/ChatServer/Services/QueryStringUserIdProvider.cs`:

```csharp
using Microsoft.AspNetCore.SignalR;

namespace ChatServer.Services;

public class QueryStringUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection)
    {
        return connection.GetHttpContext()?.Request.Query["user"];
    }
}
```

Nota: esta classe não ganha teste de unidade dedicado — `HubConnectionContext` não é
trivial de instanciar isoladamente em teste (depende de infraestrutura interna do
SignalR), e a lógica em si é uma única linha. A verificação real acontece na Task 3
(o Hub usando `Context.UserIdentifier` em testes com um contexto falso) e na Task 10
(validação manual em navegador de verdade).

- [ ] **Step 2: Registrar o provider**

`backend/ChatServer/Program.cs` — adicionar o `using` e a linha de registro (em
qualquer ponto antes de `builder.Build()`, ao lado do restante da configuração de
SignalR):

```csharp
using Microsoft.AspNetCore.SignalR;
```

```csharp
builder.Services.AddSignalR()
    .AddStackExchangeRedis(redisConnection);

builder.Services.AddSingleton<IUserIdProvider, QueryStringUserIdProvider>();
```

- [ ] **Step 3: Confirmar que compila**

Run: `cd backend && dotnet build`
Expected: build limpo (a verificação funcional real fica pra Task 3, quando o Hub
passa a usar `Context.UserIdentifier`).

- [ ] **Step 4: Commit**

```bash
git add backend/ChatServer/Services/QueryStringUserIdProvider.cs backend/ChatServer/Program.cs
git commit -m "feat: identificar conexao via query string (IUserIdProvider)"
```

---

## Task 3: Reescrever o ChatHub — Sala Geral automática + mensagem privada

**Files:**
- Modify: `backend/ChatServer/Hubs/ChatHub.cs`
- Modify: `backend/ChatServer.Tests/ChatHubTests.cs`

**Interfaces:**
- Consumes: `Context.UserIdentifier` (Task 2), `IRoomPresenceService.AddUserAsync`/
  `RemoveUserAsync` (sem mudança de assinatura, já existentes).
- Produces: contrato do Hub que o frontend (Tasks 6-8) consome:
  - `OnConnectedAsync()` — entra sozinho na Sala Geral, manda `RoomJoined(string[])`
    pro chamador e `UserJoined(string userName, string replica)` pros outros.
  - `SendMessage(string message)` — manda `ReceiveMessage(string userName, string message, string replica)` pro grupo Geral. **Não recebe mais `roomName`.**
  - `SendPrivateMessage(string toUserName, string message)` — manda
    `ReceivePrivateMessage(string fromUserName, string message, string replica)` só
    pro destinatário.
  - `OnDisconnectedAsync` — sai da Geral, manda `UserLeft(string userName, string replica)`.
  - **`JoinRoom` deixa de existir.**

- [ ] **Step 1: Escrever os testes que falham**

`backend/ChatServer.Tests/ChatHubTests.cs` (substitui o arquivo inteiro):

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

        var groups = new Mock<IGroupManager>();
        var callerProxy = new Mock<ISingleClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Caller).Returns(callerProxy.Object);
        clients.Setup(c => c.OthersInGroup("Geral")).Returns(Mock.Of<IClientProxy>());

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
    public async Task SendMessage_BroadcastsToGeralGroup()
    {
        var groupProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.Group("Geral")).Returns(groupProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), Mock.Of<IRoomPresenceService>())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendMessage("oi pessoal");

        groupProxy.Verify(
            p => p.SendCoreAsync(
                "ReceiveMessage",
                It.Is<object[]>(a => (string)a[0]! == "Ana" && (string)a[1]! == "oi pessoal" && (string)a[2]! == "test-replica"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task SendPrivateMessage_DeliversOnlyToTargetUser()
    {
        var targetProxy = new Mock<IClientProxy>();
        var clients = new Mock<IHubCallerClients>();
        clients.Setup(c => c.User("Bob")).Returns(targetProxy.Object);

        var hub = new ChatHub(Mock.Of<ILogger<ChatHub>>(), BuildConfig(), Mock.Of<IRoomPresenceService>())
        {
            Clients = clients.Object,
            Context = new FakeHubCallerContext("conn-1", "Ana")
        };

        await hub.SendPrivateMessage("Bob", "oi Bob, so pra voce");

        targetProxy.Verify(
            p => p.SendCoreAsync(
                "ReceivePrivateMessage",
                It.Is<object[]>(a => (string)a[0]! == "Ana" && (string)a[1]! == "oi Bob, so pra voce" && (string)a[2]! == "test-replica"),
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
        public override void Abort() { }

        public FakeHubCallerContext(string connectionId, string? userIdentifier)
        {
            ConnectionId = connectionId;
            UserIdentifier = userIdentifier;
        }
    }
}
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd backend && dotnet test`
Expected: FALHA de compilação — `ChatHub` ainda não tem `OnConnectedAsync` público
sobrescrito nesse formato, nem `SendPrivateMessage`, e `SendMessage` ainda pede
`roomName`.

- [ ] **Step 3: Reescrever o ChatHub**

`backend/ChatServer/Hubs/ChatHub.cs` (substitui o arquivo inteiro):

```csharp
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
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd backend && dotnet test`
Expected: PASS — os 4 testes em `ChatHubTests` verdes, output limpo.

- [ ] **Step 5: Commit**

```bash
git add backend/ChatServer/Hubs/ChatHub.cs backend/ChatServer.Tests/ChatHubTests.cs
git commit -m "feat: sala geral automatica e mensagem privada por usuario"
```

---

## Task 4: Expiração (TTL) da presença no Redis

**Files:**
- Modify: `backend/ChatServer/Services/RedisRoomPresenceService.cs`

**Interfaces:**
- Consumes: nada de novo (mesma interface `IRoomPresenceService`).
- Produces: nenhuma mudança de contrato — só um efeito colateral (a chave de presença
  no Redis expira sozinha depois de um tempo sem atividade).

- [ ] **Step 1: Adicionar expiração após cada escrita**

`backend/ChatServer/Services/RedisRoomPresenceService.cs` (substitui o arquivo
inteiro):

```csharp
using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisRoomPresenceService : IRoomPresenceService
{
    // Não é uma solução perfeita: se a sala ficar totalmente parada (ninguém entra
    // ou sai) por mais de 4h, a chave expira mesmo com gente ainda conectada — nesse
    // caso a próxima entrada/saída recria a chave normalmente. O objetivo aqui é só
    // evitar usuários "fantasma" presos pra sempre depois de uma queda abrupta do
    // servidor (ex: falta de energia), não substituir uma heartbeat de verdade.
    private static readonly TimeSpan PresenceTtl = TimeSpan.FromHours(4);

    private readonly IConnectionMultiplexer _redis;

    public RedisRoomPresenceService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetAddAsync(RoomKey(roomName), userName);
        await db.KeyExpireAsync(RoomKey(roomName), PresenceTtl);
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetRemoveAsync(RoomKey(roomName), userName);
        await db.KeyExpireAsync(RoomKey(roomName), PresenceTtl);
        return await GetUsersAsync(roomName);
    }

    private async Task<IReadOnlyList<string>> GetUsersAsync(string roomName)
    {
        var db = _redis.GetDatabase();
        var members = await db.SetMembersAsync(RoomKey(roomName));
        return members.Select(m => m.ToString()).ToList();
    }

    private static string RoomKey(string roomName) => $"room:{roomName}:users";
}
```

- [ ] **Step 2: Rodar os testes de unidade (não dependem de Redis real)**

Run: `cd backend && dotnet test`
Expected: PASS, mesmos 4 testes de antes (mockam `IRoomPresenceService`, não tocam
nesta implementação).

- [ ] **Step 3: Validar manualmente com Redis real**

Run: `docker compose up --build -d`, entre no chat pelo navegador uma vez, depois:
```bash
docker compose exec redis redis-cli TTL room:Geral:users
```
Expected: um número positivo (segundos restantes, próximo de 14400 = 4h) — prova
de que a expiração foi de fato aplicada, não só "compilou".

- [ ] **Step 4: Commit**

```bash
git add backend/ChatServer/Services/RedisRoomPresenceService.cs
git commit -m "feat: expiracao (TTL) na presenca do Redis"
```

---

## Task 5: Remover a página de teste manual e o static file serving morto

**Files:**
- Delete: `backend/ChatServer/wwwroot/test.html`
- Modify: `backend/ChatServer/Program.cs`

**Interfaces:**
- Consumes: nada.
- Produces: nada (só remoção de código/arquivo morto).

- [ ] **Step 1: Apagar a página de teste**

```bash
rm backend/ChatServer/wwwroot/test.html
```

- [ ] **Step 2: Remover o middleware de arquivos estáticos (não serve mais nada)**

`backend/ChatServer/Program.cs` — remover estas duas linhas (o Nginx já serve o
Angular desde o ciclo anterior; nada mais no backend precisa de arquivos estáticos):

```csharp
app.UseDefaultFiles();
app.UseStaticFiles();
```

- [ ] **Step 3: Confirmar que builda e os testes continuam passando**

Run: `cd backend && dotnet build && dotnet test`
Expected: build limpo, 4/4 testes passando.

- [ ] **Step 4: Commit**

```bash
git add -A backend/
git commit -m "chore: remover pagina de teste manual e static files mortos"
```

---

## Task 6: ChatService — conexão identificada, Sala Geral e mensagens privadas

**Files:**
- Modify: `frontend/src/app/services/chat.service.ts`

**Interfaces:**
- Consumes: contrato do Hub da Task 3 (`SendMessage(message)`,
  `SendPrivateMessage(toUserName, message)`, eventos `RoomJoined`/`UserJoined`/
  `UserLeft`/`ReceiveMessage`/`ReceivePrivateMessage`).
- Produces (consumido pelas Tasks 7-9):
  - `connect(userName: string): Promise<void>`
  - `sendMessage(message: string): Promise<void>`
  - `sendPrivateMessage(toUserName: string, message: string): Promise<void>`
  - `isConnected: boolean` (getter)
  - `currentUserName: Signal<string>`
  - `onlineUsers: Signal<string[]>`
  - `geralMessages: Signal<ChatMessage[]>`
  - `privateMessages: Signal<Map<string, ChatMessage[]>>` (chave = nome da outra
    pessoa na conversa)

- [ ] **Step 1: Reescrever o ChatService**

`frontend/src/app/services/chat.service.ts` (substitui o arquivo inteiro):

```typescript
import { Injectable, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';

export interface ChatMessage {
  userName: string;
  message: string;
  replica: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private connection?: signalR.HubConnection;

  readonly currentUserName = signal<string>('');
  readonly onlineUsers = signal<string[]>([]);
  readonly geralMessages = signal<ChatMessage[]>([]);
  readonly privateMessages = signal<Map<string, ChatMessage[]>>(new Map());

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

    this.connection.on('ReceiveMessage', (fromUser: string, message: string, replica: string) => {
      this.geralMessages.update(msgs => [...msgs, { userName: fromUser, message, replica }]);
    });

    this.connection.on('ReceivePrivateMessage', (fromUser: string, message: string, replica: string) => {
      this.privateMessages.update(map => {
        const next = new Map(map);
        const existing = next.get(fromUser) ?? [];
        next.set(fromUser, [...existing, { userName: fromUser, message, replica }]);
        return next;
      });
    });

    await this.connection.start();
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
      next.set(toUserName, [...existing, { userName: this.currentUserName(), message, replica: '' }]);
      return next;
    });
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `cd frontend && npx ng build`
Expected: **o build vai falhar** — mas só com erros originados em
`join-room.component.ts` e `chat-room.component.ts` (que ainda chamam a API
antiga: `connect()` sem argumento, `joinRoom`, `sendMessage` com 3 argumentos,
`messages`). Isso é esperado — essas duas telas só são atualizadas nas Tasks 7 e
8. Confirme que **nenhum erro aponta pra dentro de `chat.service.ts`** (o arquivo
que você escreveu) — se todos os erros forem só nos dois componentes antigos, o
`ChatService` está correto. O build só volta a ficar limpo depois da Task 8.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/services/chat.service.ts
git commit -m "feat: ChatService com identidade na conexao e mensagem privada"
```

---

## Task 7: Tela de entrada simplificada (só nome, sem sala)

**Files:**
- Modify: `frontend/src/app/pages/join-room/join-room.component.ts`

**Interfaces:**
- Consumes: `ChatService.connect(userName)` (Task 6).
- Produces: navega pra `/chat?user=<userName>` ao entrar — contrato de rota
  consumido pela Task 8.

- [ ] **Step 1: Reescrever o componente**

`frontend/src/app/pages/join-room/join-room.component.ts` (substitui o arquivo
inteiro):

```typescript
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-join-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="join-container">
      <h1>Entrar no chat</h1>
      <input pInputText [(ngModel)]="userName" placeholder="Seu nome" (keyup.enter)="join()" />
      <p-button label="Entrar" (onClick)="join()" [disabled]="!userName.trim()" />
      @if (errorMessage) {
        <p class="error-text">{{ errorMessage }}</p>
      }
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  errorMessage = '';

  constructor(private chatService: ChatService, private router: Router) {}

  async join(): Promise<void> {
    if (!this.userName.trim()) return;

    this.errorMessage = '';
    try {
      await this.chatService.connect(this.userName);
      this.router.navigate(['/chat'], { queryParams: { user: this.userName } });
    } catch {
      this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
    }
  }
}
```

Nota: o CSS de `.join-container`/`.error-text` fica pra Task 9 (redesign visual) —
por enquanto o elemento existe e funciona, só sem estilo bonito ainda.

- [ ] **Step 2: Verificar que compila (com a ressalva já conhecida)**

Run: `cd frontend && npx ng build`
Expected: ainda vai falhar — mas agora **só** com erros em
`chat-room.component.ts` (que só é atualizado na Task 8). Confirme que nenhum
erro aponta pra `join-room.component.ts` (o arquivo que você acabou de reescrever)
nem pra `chat.service.ts`. Um teste manual completo com `ng serve` só é possível
depois da Task 8 (é isso que a Task 8 valida) — não tente rodar `ng serve` agora,
a tela de chat ainda está com a API antiga.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/pages/join-room/join-room.component.ts
git commit -m "feat: simplificar tela de entrada (so nome, sem sala)"
```

---

## Task 8: Tela principal — Sala Geral, lista online clicável e chat privado

**Files:**
- Modify: `frontend/src/app/pages/chat-room/chat-room.component.ts`
- Modify: `frontend/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `ChatService.onlineUsers`, `geralMessages`, `privateMessages`,
  `currentUserName`, `sendMessage`, `sendPrivateMessage`, `isConnected`, `connect`
  (Task 6); query param `user` (Task 7).
- Produces: rota `chat` (sem mais `:room`) renderizando `ChatRoomComponent`.

- [ ] **Step 1: Atualizar a rota**

`frontend/src/app/app.routes.ts` (substitui o arquivo inteiro):

```typescript
import { Routes } from '@angular/router';
import { JoinRoomComponent } from './pages/join-room/join-room.component';
import { ChatRoomComponent } from './pages/chat-room/chat-room.component';

export const routes: Routes = [
  { path: '', component: JoinRoomComponent },
  { path: 'chat', component: ChatRoomComponent }
];
```

- [ ] **Step 2: Reescrever o componente da tela principal**

`frontend/src/app/pages/chat-room/chat-room.component.ts` (substitui o arquivo
inteiro):

```typescript
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatMessage, ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
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
                (click)="activeView = user; errorMessage = ''"
              >{{ user }}</button>
            </li>
          }
        </ul>
      </aside>
      <main class="conversation">
        <h3>{{ activeView === 'geral' ? 'Sala Geral' : 'Privado com ' + activeView }}</h3>
        @if (errorMessage) {
          <p class="error-text">{{ errorMessage }}</p>
        }
        <ul class="message-list">
          @for (msg of currentMessages(); track $index) {
            <li class="message" [class.mine]="msg.userName === chatService.currentUserName()">
              <strong>{{ msg.userName }}</strong>
              @if (msg.replica) { <span class="replica-tag">({{ msg.replica }})</span> }
              : {{ msg.message }}
            </li>
          }
        </ul>
        <div class="input-row">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  userName = '';
  draft = '';
  activeView: 'geral' | string = 'geral';
  errorMessage = '';

  constructor(private route: ActivatedRoute, public chatService: ChatService) {}

  async ngOnInit(): Promise<void> {
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.chatService.isConnected && this.userName) {
      try {
        await this.chatService.connect(this.userName);
      } catch {
        this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
      }
    }
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

Notas importantes pra quem for implementar:
- Usa o control flow nativo do Angular (`@if`/`@for`) — **não** importa
  `CommonModule`/`NgFor` (não precisa mais, ao contrário do ciclo anterior).
- `errorMessage` é limpo tanto ao trocar de conversa quanto ao início de cada envio
  — resolve o achado da revisão final anterior sobre o aviso de erro que não sumia
  sozinho.
- O CSS de `.sidebar`, `.conversation-item.active`, `.message.mine`, etc. fica pra
  Task 9 — a estrutura e o comportamento já ficam corretos aqui, só sem o visual
  final.

- [ ] **Step 3: Validar manualmente end-to-end (com o stack completo rodando)**

Run: `docker compose up --build -d`, depois `ng serve` como na Task 7.

Abra em duas abas, entre com "Ana" numa e "Bob" na outra. Confirme:
- As duas aparecem uma na lista de online da outra, sem precisar digitar nome de
  sala.
- Mensagens na Sala Geral chegam nas duas abas.
- Clicar no nome da outra pessoa abre uma conversa privada; mensagem mandada ali
  chega só na aba da pessoa certa (não aparece na Sala Geral nem em nenhuma outra
  conversa).
- Recarregar a página (F5) numa aba reconecta e continua funcionando (a Sala Geral
  entra sozinha de novo).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/pages/chat-room/chat-room.component.ts frontend/src/app/app.routes.ts
git commit -m "feat: sala geral com lista online clicavel e chat privado"
```

---

## Task 9: Redesign visual — tema escuro por padrão + alternância pra claro

**Files:**
- Create: `frontend/src/app/services/theme.service.ts`
- Modify: `frontend/src/styles.scss`
- Modify: `frontend/src/app/app.config.ts`
- Modify: `frontend/src/app/pages/join-room/join-room.component.ts`
- Modify: `frontend/src/app/pages/chat-room/chat-room.component.ts`

**Interfaces:**
- Consumes: estrutura HTML das Tasks 7-8 (classes `.error-text`, `.sidebar`,
  `.conversation-item`, `.message`, etc. já existem, só sem CSS ainda).
- Produces: `ThemeService.mode: Signal<'dark' | 'light'>`, `ThemeService.toggle()`.

- [ ] **Step 1: Criar o serviço de tema**

`frontend/src/app/services/theme.service.ts`:

```typescript
import { Injectable, signal, effect } from '@angular/core';

export type ThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'chat-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(this.loadInitialMode());

  constructor() {
    effect(() => {
      const mode = this.mode();
      document.documentElement.setAttribute('data-theme', mode);
      localStorage.setItem(STORAGE_KEY, mode);
    });
  }

  toggle(): void {
    this.mode.set(this.mode() === 'dark' ? 'light' : 'dark');
  }

  private loadInitialMode(): ThemeMode {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' ? 'light' : 'dark';
  }
}
```

- [ ] **Step 2: Definir a paleta em CSS custom properties**

`frontend/src/styles.scss` (substitui o conteúdo — hoje está vazio):

```scss
:root {
  --bg: #ffffff;
  --surface: #f4f4f5;
  --border: #e4e4e7;
  --text: #18181b;
  --text-muted: #71717a;
  --accent: #3b6fe0;
  --danger: #dc2626;
}

:root[data-theme='dark'] {
  --bg: #0e0f11;
  --surface: #17181b;
  --border: #26272b;
  --text: #e4e4e7;
  --text-muted: #a1a1aa;
  --accent: #5b8cff;
  --danger: #f87171;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, 'Segoe UI', sans-serif;
}

.error-text { color: var(--danger); font-size: 0.9rem; }
```

- [ ] **Step 3: Configurar o PrimeNG pra acompanhar o tema**

Verifique na documentação da versão do PrimeNG instalada (`frontend/node_modules/primeng/package.json`)
qual é o mecanismo atual de dark mode do preset Aura (normalmente uma opção
`darkModeSelector` em `providePrimeNG` dentro de `app.config.ts`, apontando pra um
seletor CSS). Configure esse seletor para bater com `[data-theme="dark"]` (o mesmo
atributo que o `ThemeService` já está aplicando na tag `<html>`), de forma que os
componentes do PrimeNG (botões, inputs) troquem de aparência junto com o resto da
paleta. Valide visualmente no navegador — se a versão instalada tiver uma API
diferente da esperada, adapte mantendo a intenção (tema PrimeNG sincronizado com
`ThemeService.mode`).

- [ ] **Step 4: Aplicar o visual nas telas + botão de alternância**

Adicione um botão simples de alternância de tema (ex: um ícone de sol/lua) visível
nas duas telas (`JoinRoomComponent` e `ChatRoomComponent`), chamando
`themeService.toggle()`. Estilize os elementos existentes usando as variáveis CSS
definidas no Step 2 (`var(--bg)`, `var(--surface)`, `var(--border)`, `var(--text)`,
`var(--accent)`, etc.):

- Tela de entrada: card centralizado, cantos arredondados, borda sutil (`var(--border)`).
- Lista de conversas (sidebar): item ativo com fundo levemente destacado usando
  `var(--accent)` com opacidade baixa.
- Mensagens: bolha da própria pessoa (`.message.mine`) alinhada à direita com fundo
  `var(--accent)` e texto claro; mensagens de outras pessoas alinhadas à esquerda
  com fundo `var(--surface)` e borda `var(--border)`.
- Input e botão de enviar usando os componentes do PrimeNG já em uso (`pInputText`,
  `p-button`), com a paleta do Step 3 refletindo automaticamente.

Não precisa (nem deve) ficar pixel-perfect — o objetivo é sair do visual "cru" de
antes pra algo visivelmente moderno e coerente, seguindo a paleta aprovada.

- [ ] **Step 5: Validar visualmente**

Run: `ng serve` (com o stack Docker rodando). Abra no navegador, confirme:
- O tema escuro é o que aparece por padrão ao abrir pela primeira vez.
- O botão de alternância troca pra claro e volta pra escuro corretamente.
- Recarregar a página mantém a última escolha (persistida no `localStorage`).
- As duas telas (entrada e chat) têm aparência consistente uma com a outra.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/services/theme.service.ts frontend/src/styles.scss frontend/src/app/app.config.ts frontend/src/app/pages/
git commit -m "feat: redesign visual com tema escuro padrao e alternancia"
```

---

## Task 10: Validação final + atualizar README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: stack completo (Tasks 1-9).
- Produces: documentação atualizada refletindo o estado real do projeto.

- [ ] **Step 1: Rodar o roteiro de validação completo**

Run: `docker compose up --build`

1. Abra `http://localhost/` em duas abas/perfis, entre com nomes diferentes — as
   duas caem direto na Sala Geral, sem pedir nome de sala.
2. Mande mensagem na Geral dos dois lados, confirme entrega em tempo real (inclusive
   cruzando réplicas, do jeito que já validamos no ciclo anterior).
3. Clique no nome da outra pessoa em cada aba, confirme que abre uma conversa
   privada e que mensagens ali não vazam pra Sala Geral nem pra mais ninguém.
4. Recarregue uma das abas no meio da conversa (F5) — confirme que reconecta e
   volta a aparecer na lista de online sozinho (sem precisar reentrar manualmente).
5. Alterne o tema claro/escuro, recarregue, confirme que a escolha persistiu.
6. `docker compose exec redis redis-cli TTL room:Geral:users` — confirme que retorna
   um TTL positivo.

- [ ] **Step 2: Atualizar o README**

Revise `README.md` pra refletir:
- Stack atualizado: `.NET 10` no lugar de `.NET 9`.
- Nova seção descrevendo Sala Geral + chat privado (substituindo qualquer menção ao
  antigo fluxo de "digitar nome de sala").
- Remover ou revisar a limitação antiga "reconexão não reentra na sala" — com a Sala
  Geral entrando automaticamente em `OnConnectedAsync`, isso deixou de ser um
  problema (toda reconexão já reentra sozinha). Se ainda achar relevante mencionar
  alguma nuance de reconexão, deixe claro que é sobre estado local de UI, não sobre
  a sala em si.
- Mencionar a nova limitação de chat privado (mensagem não entregue se a pessoa cair
  bem na hora do envio, sem retry) e o TTL de presença (4h, não é uma solução
  perfeita de heartbeat).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: atualizar README com sala geral, chat privado e .NET 10"
```
