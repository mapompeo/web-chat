# Chat em Tempo Real (Docker + SignalR + Redis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um chat em tempo real (Angular + PrimeNG + SignalR) rodando em 3 réplicas
de backend .NET sincronizadas via Redis backplane, atrás de um load balancer Nginx, tudo
orquestrado por Docker Compose — projeto de estudo focado em Docker e WebSocket em escala.

**Architecture:** Browser → Nginx (proxy WebSocket + serve dos arquivos estáticos do Angular)
→ 3 réplicas idênticas de um backend ASP.NET Core/SignalR → Redis (backplane de mensagens +
armazenamento de presença online). Réplicas são stateless entre si; toda sincronização passa
pelo Redis.

**Tech Stack:** .NET 9 (ASP.NET Core, SignalR), StackExchange.Redis, xUnit + Moq, Angular
(standalone components, Signals), PrimeNG (tema Aura), Nginx, Docker / Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-03-chat-tempo-real-design.md`

## Global Constraints

- 3 réplicas de backend, nomeadas explicitamente `backend1`, `backend2`, `backend3` (mesma
  imagem Docker) — não usar `deploy.replicas` (decisão do design, para logs identificáveis).
- Sem autenticação e sem persistência de mensagens — fora de escopo deste MVP.
- Frontend: Angular + PrimeNG, tema **Aura**.
- Load balancer: Nginx, **sem sticky sessions** — a sincronização é responsabilidade do
  backplane Redis, não do roteamento.
- Todo o stack roda localmente via `docker compose` — sem deploy em nuvem neste projeto.
- Convenção do usuário (global, `~/.claude/CLAUDE.md`): nunca hardcodar porta de dev server.
  Ao rodar `ng serve` localmente (fora do Docker Compose), obter a porta livre via
  `~/scripts/port-for-worktree.sh` e informar a URL final usada.

---

## Task 1: Backend .NET — ChatHub com salas, presença e testes

**Files:**
- Create: `backend/ChatServer.sln`
- Create: `backend/ChatServer/ChatServer.csproj`
- Create: `backend/ChatServer/Program.cs`
- Create: `backend/ChatServer/Hubs/ChatHub.cs`
- Create: `backend/ChatServer/Services/IRoomPresenceService.cs`
- Create: `backend/ChatServer/Services/InMemoryRoomPresenceService.cs`
- Create: `backend/ChatServer/wwwroot/test.html`
- Create: `backend/ChatServer/.gitignore`
- Create: `backend/ChatServer.Tests/ChatServer.Tests.csproj`
- Test: `backend/ChatServer.Tests/ChatHubTests.cs`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces:
  - `IRoomPresenceService.AddUserAsync(string roomName, string userName) -> Task<IReadOnlyList<string>>`
  - `IRoomPresenceService.RemoveUserAsync(string roomName, string userName) -> Task<IReadOnlyList<string>>`
  - Hub em `/chatHub` com métodos invocáveis pelo cliente: `JoinRoom(string roomName, string userName)`, `SendMessage(string roomName, string userName, string message)`.
  - Eventos que o Hub envia ao cliente (contrato usado pelo frontend na Task 6+):
    `RoomJoined(string[] onlineUsers)`, `UserJoined(string userName, string replica)`,
    `UserLeft(string userName, string replica)`, `ReceiveMessage(string userName, string message, string replica)`.
  - Variável de ambiente `REPLICA_NAME` (lida via `IConfiguration`, default `"local"`).

- [ ] **Step 1: Criar a solução e os dois projetos**

```bash
mkdir -p backend && cd backend
dotnet new sln -n ChatServer
dotnet new web -n ChatServer -o ChatServer
dotnet new xunit -n ChatServer.Tests -o ChatServer.Tests
dotnet sln add ChatServer/ChatServer.csproj ChatServer.Tests/ChatServer.Tests.csproj
cd ChatServer.Tests
dotnet add reference ../ChatServer/ChatServer.csproj
dotnet add package Moq
cd ..
```

- [ ] **Step 2: Criar `.gitignore` do backend**

```
bin/
obj/
```

- [ ] **Step 3: Escrever a interface de presença**

`backend/ChatServer/Services/IRoomPresenceService.cs`:

```csharp
namespace ChatServer.Services;

public interface IRoomPresenceService
{
    Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName);
    Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName);
}
```

- [ ] **Step 4: Escrever o teste que falha (SendMessage)**

`backend/ChatServer.Tests/ChatHubTests.cs`:

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
```

- [ ] **Step 5: Rodar os testes e confirmar que falham**

Run: `cd backend && dotnet test`
Expected: FALHA de compilação — `ChatHub` não existe ainda no namespace `ChatServer.Hubs`.

- [ ] **Step 6: Implementar o ChatHub (mínimo para os dois testes passarem)**

`backend/ChatServer/Hubs/ChatHub.cs`:

```csharp
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
```

- [ ] **Step 7: Rodar os testes e confirmar que passam**

Run: `cd backend && dotnet test`
Expected: PASS — os 2 testes em `ChatHubTests` verdes.

- [ ] **Step 8: Implementação em memória da presença (temporária — Task 3 troca por Redis)**

`backend/ChatServer/Services/InMemoryRoomPresenceService.cs`:

```csharp
using System.Collections.Concurrent;

namespace ChatServer.Services;

public class InMemoryRoomPresenceService : IRoomPresenceService
{
    private readonly ConcurrentDictionary<string, HashSet<string>> _rooms = new();
    private readonly object _lock = new();

    public Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        lock (_lock)
        {
            var users = _rooms.GetOrAdd(roomName, _ => new HashSet<string>());
            users.Add(userName);
            return Task.FromResult<IReadOnlyList<string>>(users.ToList());
        }
    }

    public Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        lock (_lock)
        {
            if (_rooms.TryGetValue(roomName, out var users))
            {
                users.Remove(userName);
                return Task.FromResult<IReadOnlyList<string>>(users.ToList());
            }
            return Task.FromResult<IReadOnlyList<string>>(new List<string>());
        }
    }
}
```

- [ ] **Step 9: Program.cs — subir o servidor com o Hub mapeado**

`backend/ChatServer/Program.cs`:

```csharp
using ChatServer.Hubs;
using ChatServer.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR();
builder.Services.AddSingleton<IRoomPresenceService, InMemoryRoomPresenceService>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        // Origem permissiva de propósito: projeto de estudo local, sem deploy público,
        // e a porta do `ng serve` varia por worktree (ver ~/scripts/port-for-worktree.sh),
        // então não dá pra fixar uma única origem em WithOrigins().
        policy.SetIsOriginAllowed(_ => true)
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseCors("AllowFrontend");

app.MapHub<ChatHub>("/chatHub");

app.Run();
```

- [ ] **Step 10: Página HTML de teste manual (throwaway, usada até o Angular existir)**

`backend/ChatServer/wwwroot/test.html`:

```html
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <title>Teste manual do ChatHub</title>
</head>
<body>
  <h1>Teste manual do ChatHub</h1>
  <input id="userName" placeholder="Seu nome" />
  <input id="roomName" placeholder="Sala" value="sala-1" />
  <button id="joinBtn">Entrar</button>
  <hr />
  <input id="message" placeholder="Mensagem" />
  <button id="sendBtn">Enviar</button>
  <h3>Online:</h3>
  <ul id="onlineList"></ul>
  <h3>Mensagens:</h3>
  <ul id="messages"></ul>

  <script src="https://cdn.jsdelivr.net/npm/@microsoft/signalr@latest/dist/browser/signalr.min.js"></script>
  <script>
    const connection = new signalR.HubConnectionBuilder().withUrl("/chatHub").build();
    let currentRoom = "";

    connection.on("RoomJoined", (users) => {
      document.getElementById("onlineList").innerHTML = users.map(u => `<li>${u}</li>`).join("");
    });
    connection.on("UserJoined", (userName, replica) => {
      log(`${userName} entrou (via ${replica})`);
      const li = document.createElement("li");
      li.textContent = userName;
      document.getElementById("onlineList").appendChild(li);
    });
    connection.on("UserLeft", (userName, replica) => log(`${userName} saiu (via ${replica})`));
    connection.on("ReceiveMessage", (userName, message, replica) => log(`[${replica}] ${userName}: ${message}`));

    function log(text) {
      const li = document.createElement("li");
      li.textContent = text;
      document.getElementById("messages").appendChild(li);
    }

    document.getElementById("joinBtn").addEventListener("click", async () => {
      currentRoom = document.getElementById("roomName").value;
      await connection.start();
      await connection.invoke("JoinRoom", currentRoom, document.getElementById("userName").value);
    });

    document.getElementById("sendBtn").addEventListener("click", () => {
      connection.invoke("SendMessage", currentRoom, document.getElementById("userName").value, document.getElementById("message").value);
      document.getElementById("message").value = "";
    });
  </script>
</body>
</html>
```

- [ ] **Step 11: Rodar localmente e validar manualmente**

Run: `cd backend/ChatServer && dotnet run`
Abra `http://localhost:5000/test.html` (ou a porta impressa no console) em duas abas do
navegador, entre na mesma sala com nomes diferentes em cada aba, mande mensagem de uma pra
outra.
Expected: mensagem aparece nas duas abas; lista "Online" mostra os dois nomes.

- [ ] **Step 12: Commit**

```bash
git add backend/
git commit -m "feat: ChatHub com salas, presenca em memoria e testes"
```

---

## Task 2: Dockerizar o backend (container único, sem Redis ainda)

**Files:**
- Create: `backend/ChatServer/Dockerfile`
- Create: `backend/ChatServer/.dockerignore`

**Interfaces:**
- Consumes: projeto `backend/ChatServer` da Task 1 (publica via `dotnet publish`).
- Produces: imagem Docker que expõe a porta `8080` via HTTP.

- [ ] **Step 1: Dockerfile multi-stage**

`backend/ChatServer/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY ChatServer.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "ChatServer.dll"]
```

- [ ] **Step 2: `.dockerignore`**

`backend/ChatServer/.dockerignore` (deve ficar na raiz do contexto de build — `cd backend/ChatServer && docker build .` — não em `backend/`, senão o Docker nunca a encontra):

```
**/bin/
**/obj/
```

- [ ] **Step 3: Build e run manual do container**

Run:
```bash
cd backend/ChatServer
docker build -t chat-backend .
docker run --rm -p 5000:8080 chat-backend
```
Abra `http://localhost:5000/test.html`, repita o teste manual de duas abas da Task 1.
Expected: mesmo comportamento de antes, agora rodando dentro de um container.

- [ ] **Step 4: Commit**

```bash
git add backend/
git commit -m "chore: dockerizar o backend"
```

---

## Task 3: Redis — backplane do SignalR + presença persistida no Redis

**Files:**
- Create: `backend/ChatServer/Services/RedisRoomPresenceService.cs`
- Delete: `backend/ChatServer/Services/InMemoryRoomPresenceService.cs`
- Modify: `backend/ChatServer/Program.cs`
- Create: `docker-compose.yml` (raiz do repo)

**Interfaces:**
- Consumes: `IRoomPresenceService` (Task 1), Dockerfile do backend (Task 2).
- Produces: variável de ambiente `REDIS_CONNECTION` (formato `host:porta`), serviço `redis`
  no `docker-compose.yml`, serviço `backend` conectado a ele.

- [ ] **Step 1: Adicionar o pacote do backplane Redis**

```bash
cd backend/ChatServer
dotnet add package Microsoft.AspNetCore.SignalR.StackExchangeRedis
```

- [ ] **Step 2: Implementar a presença via Redis**

`backend/ChatServer/Services/RedisRoomPresenceService.cs`:

```csharp
using StackExchange.Redis;

namespace ChatServer.Services;

public class RedisRoomPresenceService : IRoomPresenceService
{
    private readonly IConnectionMultiplexer _redis;

    public RedisRoomPresenceService(IConnectionMultiplexer redis)
    {
        _redis = redis;
    }

    public async Task<IReadOnlyList<string>> AddUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetAddAsync(RoomKey(roomName), userName);
        return await GetUsersAsync(roomName);
    }

    public async Task<IReadOnlyList<string>> RemoveUserAsync(string roomName, string userName)
    {
        var db = _redis.GetDatabase();
        await db.SetRemoveAsync(RoomKey(roomName), userName);
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

- [ ] **Step 3: Remover a implementação em memória**

```bash
rm backend/ChatServer/Services/InMemoryRoomPresenceService.cs
```

- [ ] **Step 4: Atualizar Program.cs para usar Redis (backplane + presença)**

`backend/ChatServer/Program.cs`:

```csharp
using ChatServer.Hubs;
using ChatServer.Services;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var redisConnection = builder.Configuration["REDIS_CONNECTION"] ?? "localhost:6379";

builder.Services.AddSingleton<IConnectionMultiplexer>(
    ConnectionMultiplexer.Connect(redisConnection));
builder.Services.AddSingleton<IRoomPresenceService, RedisRoomPresenceService>();

builder.Services.AddSignalR()
    .AddStackExchangeRedis(redisConnection);

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        // Origem permissiva de propósito: projeto de estudo local, sem deploy público,
        // e a porta do `ng serve` varia por worktree (ver ~/scripts/port-for-worktree.sh),
        // então não dá pra fixar uma única origem em WithOrigins().
        policy.SetIsOriginAllowed(_ => true)
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseCors("AllowFrontend");

app.MapHub<ChatHub>("/chatHub");

app.Run();
```

- [ ] **Step 5: docker-compose.yml — Redis + 1 backend (ainda sem múltiplas réplicas)**

`docker-compose.yml` (raiz do repo):

```yaml
services:
  redis:
    image: redis:7-alpine

  backend:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend
      - REDIS_CONNECTION=redis:6379
    ports:
      - "5000:8080"
    depends_on:
      - redis
```

- [ ] **Step 6: Rodar os testes de unidade (garantir que nada quebrou)**

Run: `cd backend && dotnet test`
Expected: PASS (os testes mockam `IRoomPresenceService`, não dependem do Redis real).

- [ ] **Step 7: Subir via Docker Compose e validar o Redis de verdade**

Run:
```bash
docker compose up --build
```
Em outro terminal, entre numa sala pelo `test.html` (`http://localhost:5000/test.html`) e
depois rode:
```bash
docker compose exec redis redis-cli SMEMBERS room:sala-1:users
```
Expected: o nome do usuário que você usou aparece na saída — prova de que a presença está
sendo armazenada no Redis, não mais em memória do processo.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: presenca e backplane via Redis"
```

---

## Task 4: Escalar para 3 réplicas nomeadas do backend

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: serviço `backend` único (Task 3), variáveis `REPLICA_NAME`/`REDIS_CONNECTION`.
- Produces: serviços `backend1`, `backend2`, `backend3` (mesma imagem), acessíveis
  diretamente nas portas `5001`, `5002`, `5003` (temporário — a Task 5 remove esse acesso
  direto ao introduzir o Nginx).

- [ ] **Step 1: Substituir o serviço `backend` único por 3 réplicas nomeadas**

`docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine

  backend1:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend1
      - REDIS_CONNECTION=redis:6379
    ports:
      - "5001:8080"
    depends_on:
      - redis

  backend2:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend2
      - REDIS_CONNECTION=redis:6379
    ports:
      - "5002:8080"
    depends_on:
      - redis

  backend3:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend3
      - REDIS_CONNECTION=redis:6379
    ports:
      - "5003:8080"
    depends_on:
      - redis
```

- [ ] **Step 2: Validar a sincronização entre réplicas — o "aha moment" do projeto**

Run: `docker compose up --build`

Abra `http://localhost:5001/test.html` na Aba A (entre como "Ana" na sala "sala-1").
Abra `http://localhost:5002/test.html` na Aba B (entre como "Bob" na mesma sala).
Mande uma mensagem da Aba A.

Expected:
- A mensagem aparece na Aba B mesmo estando em uma réplica diferente — e a prova de
  que ela veio via Redis está no próprio conteúdo: a linha em `test.html` mostra
  `[backend1] Ana: oi`, ou seja, a Aba B (conectada na `backend2`) recebeu uma
  mensagem marcada com o nome de uma réplica diferente da sua. Isso só é possível
  porque a mensagem saiu da `backend1`, foi publicada no Redis, e a `backend2`
  repassou pro seu cliente.
- Rodando `docker compose logs -f`, você vê em `backend1` as linhas de "entrou na
  sala" (Ana) e "mensagem de Ana" — mas **não** espere uma linha equivalente em
  `backend2` para essa mensagem: a entrega via Redis backplane acontece dentro da
  biblioteca do SignalR (`AddStackExchangeRedis`), fora do código do Hub, então não
  há (e não precisa haver) um log custom nesse ponto. O log do lado que *recebeu a
  chamada do cliente* (`backend1`) + o conteúdo marcado com a réplica de origem que
  chegou no cliente da `backend2` já são prova suficiente e verificável.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: escalar backend para 3 replicas nomeadas"
```

---

## Task 5: Nginx como load balancer (ponto de entrada único)

**Files:**
- Create: `nginx/nginx.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: serviços `backend1`, `backend2`, `backend3` da Task 4 (nomes de host resolvidos
  pela rede interna do Docker Compose).
- Produces: ponto de entrada único em `http://localhost/` (porta 80), incluindo
  `http://localhost/chatHub`.

- [ ] **Step 1: Configuração do Nginx com upgrade de WebSocket**

`nginx/nginx.conf`:

```nginx
events {}

http {
    upstream chat_backend {
        server backend1:8080;
        server backend2:8080;
        server backend3:8080;
    }

    server {
        listen 80;

        location /chatHub {
            proxy_pass http://chat_backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        location / {
            proxy_pass http://chat_backend;
            proxy_set_header Host $host;
        }
    }
}
```

- [ ] **Step 2: Adicionar o serviço Nginx e remover as portas diretas dos backends**

`docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine

  backend1:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend1
      - REDIS_CONNECTION=redis:6379
    depends_on:
      - redis

  backend2:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend2
      - REDIS_CONNECTION=redis:6379
    depends_on:
      - redis

  backend3:
    build: ./backend/ChatServer
    environment:
      - REPLICA_NAME=backend3
      - REDIS_CONNECTION=redis:6379
    depends_on:
      - redis

  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "80:80"
    depends_on:
      - backend1
      - backend2
      - backend3
```

- [ ] **Step 3: Validar o balanceamento através do Nginx**

Run: `docker compose up --build`

Abra `http://localhost/test.html` em duas abas (agora sem especificar porta de réplica —
o Nginx decide). Entre na mesma sala nas duas, mande mensagens.

Expected: chat funciona normalmente; em `docker compose logs -f` você vê as duas conexões
caindo em réplicas (possivelmente) diferentes, escolhidas pelo Nginx via round-robin.

- [ ] **Step 4: Commit**

```bash
git add nginx/ docker-compose.yml
git commit -m "feat: nginx como load balancer na frente das replicas"
```

---

## Task 6: Scaffold do frontend Angular + PrimeNG + ChatService

**Files:**
- Create: `frontend/` (gerado pelo Angular CLI)
- Create: `frontend/src/app/services/chat.service.ts`
- Modify: `frontend/src/app/app.config.ts`
- Create: `frontend/proxy.conf.json`

**Interfaces:**
- Consumes: contrato do Hub definido na Task 1 (`/chatHub`, métodos `JoinRoom`/`SendMessage`,
  eventos `RoomJoined`/`UserJoined`/`UserLeft`/`ReceiveMessage`).
- Produces:
  - `ChatService.connect(): Promise<void>`
  - `ChatService.joinRoom(roomName: string, userName: string): Promise<void>`
  - `ChatService.sendMessage(roomName: string, userName: string, message: string): Promise<void>`
  - `ChatService.onlineUsers: Signal<string[]>`
  - `ChatService.messages: Signal<ChatMessage[]>` onde `ChatMessage = { userName: string; message: string; replica: string }`

- [ ] **Step 1: Gerar o projeto Angular e instalar dependências**

```bash
npx @angular/cli@latest new frontend --routing --style=scss --skip-git --ssr=false
cd frontend
npm install primeng primeicons @primeuix/themes
npm install @angular/animations
npm install @microsoft/signalr
```

- [ ] **Step 2: Configurar o tema PrimeNG Aura**

`frontend/src/app/app.config.ts`:

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: Aura
      }
    })
  ]
};
```

- [ ] **Step 3: Criar o ChatService**

`frontend/src/app/services/chat.service.ts`:

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

  readonly onlineUsers = signal<string[]>([]);
  readonly messages = signal<ChatMessage[]>([]);

  async connect(): Promise<void> {
    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente — a segunda
      // rejeita a conexão porque o connectionId só existe na réplica que negociou.
      // Pulando a negociação, a conexão vira uma única requisição atômica.
      .withUrl('/chatHub', {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets
      })
      .withAutomaticReconnect()
      .build();

    this.connection.on('RoomJoined', (users: string[]) => {
      this.onlineUsers.set(users);
    });

    this.connection.on('UserJoined', (userName: string) => {
      this.onlineUsers.update(users => [...users, userName]);
    });

    this.connection.on('UserLeft', (userName: string) => {
      this.onlineUsers.update(users => users.filter(u => u !== userName));
    });

    this.connection.on('ReceiveMessage', (userName: string, message: string, replica: string) => {
      this.messages.update(msgs => [...msgs, { userName, message, replica }]);
    });

    await this.connection.start();
  }

  async joinRoom(roomName: string, userName: string): Promise<void> {
    await this.connection?.invoke('JoinRoom', roomName, userName);
  }

  async sendMessage(roomName: string, userName: string, message: string): Promise<void> {
    await this.connection?.invoke('SendMessage', roomName, userName, message);
  }
}
```

- [ ] **Step 4: Proxy do dev server pro Nginx (evita CORS/path issues no `ng serve`)**

`frontend/proxy.conf.json`:

```json
{
  "/chatHub": {
    "target": "http://localhost:80",
    "ws": true,
    "changeOrigin": true
  }
}
```

- [ ] **Step 5: Verificar que o projeto compila**

Run: `cd frontend && npx ng build`
Expected: build concluído sem erros (ainda não há UI usando o `ChatService`, só confirma
que o scaffold e o serviço compilam).

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "chore: scaffold do Angular com PrimeNG e ChatService"
```

---

## Task 7: Tela de entrada na sala (Join Room)

**Files:**
- Create: `frontend/src/app/pages/join-room/join-room.component.ts`
- Modify: `frontend/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `ChatService.connect()` e `ChatService.joinRoom()` (Task 6).
- Produces: rota `''` (raiz) renderizando `JoinRoomComponent`; navega para
  `/room/:room?user=<userName>` ao entrar — contrato de rota consumido pela Task 8.

- [ ] **Step 1: Criar o componente de entrada**

`frontend/src/app/pages/join-room/join-room.component.ts`:

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
    <div class="join-container" style="max-width: 320px; margin: 4rem auto; display: flex; flex-direction: column; gap: 1rem;">
      <h1>Entrar no chat</h1>
      <input pInputText [(ngModel)]="userName" placeholder="Seu nome" />
      <input pInputText [(ngModel)]="roomName" placeholder="Nome da sala" />
      <p-button label="Entrar" (onClick)="join()" [disabled]="!userName || !roomName" />
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  roomName = '';

  constructor(private chatService: ChatService, private router: Router) {}

  async join(): Promise<void> {
    await this.chatService.connect();
    await this.chatService.joinRoom(this.roomName, this.userName);
    this.router.navigate(['/room', this.roomName], { queryParams: { user: this.userName } });
  }
}
```

- [ ] **Step 2: Registrar a rota**

`frontend/src/app/app.routes.ts`:

```typescript
import { Routes } from '@angular/router';
import { JoinRoomComponent } from './pages/join-room/join-room.component';

export const routes: Routes = [
  { path: '', component: JoinRoomComponent }
];
```

- [ ] **Step 3: Validar manualmente (precisa do stack do Task 5 rodando)**

Run:
```bash
docker compose up --build -d   # sobe redis + 3 backends + nginx (Tasks 3-5)
cd frontend
PORT=$(~/scripts/port-for-worktree.sh)
npx ng serve --port $PORT --proxy-config proxy.conf.json
```

Informe ao usuário a porta escolhida e a URL (`http://localhost:$PORT`). Abra essa URL,
preencha nome e sala, clique em "Entrar".

Expected: navega para `/room/<sala>`, sem tela ainda (Task 8 implementa) — mas sem erros de
console e a conexão SignalR abre com sucesso (verificável na aba Network do navegador).

- [ ] **Step 4: Commit**

```bash
git add frontend/
git commit -m "feat: tela de entrada na sala"
```

---

## Task 8: Tela da sala de chat (mensagens + presença online)

**Files:**
- Create: `frontend/src/app/pages/chat-room/chat-room.component.ts`
- Modify: `frontend/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `ChatService.onlineUsers`, `ChatService.messages`, `ChatService.sendMessage()`
  (Task 6); parâmetro de rota `room` e query param `user` (Task 7).
- Produces: rota `room/:room` renderizando `ChatRoomComponent`.

- [ ] **Step 1: Criar o componente da sala**

`frontend/src/app/pages/chat-room/chat-room.component.ts`:

```typescript
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="chat-container" style="display: flex; gap: 2rem; max-width: 900px; margin: 2rem auto;">
      <aside style="width: 200px;">
        <h3>Sala: {{ roomName }}</h3>
        <h4>Online</h4>
        <ul>
          <li *ngFor="let user of chatService.onlineUsers()">{{ user }}</li>
        </ul>
      </aside>
      <main style="flex: 1;">
        <ul style="list-style: none; padding: 0;">
          <li *ngFor="let msg of chatService.messages()">
            <strong>{{ msg.userName }}</strong> ({{ msg.replica }}): {{ msg.message }}
          </li>
        </ul>
        <div style="display: flex; gap: 0.5rem;">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" style="flex: 1;" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  roomName = '';
  userName = '';
  draft = '';

  constructor(private route: ActivatedRoute, public chatService: ChatService) {}

  ngOnInit(): void {
    this.roomName = this.route.snapshot.paramMap.get('room') ?? '';
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';
  }

  send(): void {
    if (!this.draft.trim()) return;
    this.chatService.sendMessage(this.roomName, this.userName, this.draft);
    this.draft = '';
  }
}
```

- [ ] **Step 2: Registrar a rota**

`frontend/src/app/app.routes.ts`:

```typescript
import { Routes } from '@angular/router';
import { JoinRoomComponent } from './pages/join-room/join-room.component';
import { ChatRoomComponent } from './pages/chat-room/chat-room.component';

export const routes: Routes = [
  { path: '', component: JoinRoomComponent },
  { path: 'room/:room', component: ChatRoomComponent }
];
```

- [ ] **Step 3: Validar end-to-end pela primeira vez com a UI real**

Run (com `docker compose up -d` já rodando do Task 5):
```bash
cd frontend
PORT=$(~/scripts/port-for-worktree.sh)
npx ng serve --port $PORT --proxy-config proxy.conf.json
```

Abra `http://localhost:$PORT` em duas abas/perfis diferentes, entre na mesma sala com
nomes diferentes.

Expected: mensagens aparecem em tempo real nas duas abas, com o nome da réplica que
processou cada uma; lista "Online" mostra ambos os usuários.

- [ ] **Step 4: Commit**

```bash
git add frontend/
git commit -m "feat: tela da sala de chat com mensagens e presenca online"
```

---

## Task 9: Nginx serve o Angular buildado + proxy (stack final containerizado)

**Files:**
- Create: `nginx/Dockerfile`
- Modify: `nginx/nginx.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: build de produção do Angular (Task 6-8), `nginx.conf` da Task 5.
- Produces: `http://localhost/` servindo o Angular real (não mais o `test.html`), com
  `/chatHub` proxyado para as 3 réplicas — stack 100% containerizado.

- [ ] **Step 1: Dockerfile multi-stage do Nginx (build do Angular + imagem final)**

`nginx/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx/nginx.conf /etc/nginx/nginx.conf
```

Nota: se `npm run build` gerar a saída em um caminho diferente de
`dist/frontend/browser` (confira em `frontend/angular.json`, campo `outputPath`, ou rode
`ls frontend/dist` após o build), ajuste o caminho do `COPY --from=build` de acordo.

- [ ] **Step 2: Atualizar o nginx.conf para servir o Angular com fallback de SPA**

`nginx/nginx.conf`:

```nginx
events {}

http {
    # Sem isso, o Nginx serve os .js do Angular como application/octet-stream
    # (o tipo genérico de fallback), e o navegador recusa executar o módulo ES —
    # a página carrega em branco mesmo com todas as respostas retornando 200.
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    upstream chat_backend {
        server backend1:8080;
        server backend2:8080;
        server backend3:8080;
    }

    server {
        listen 80;
        root /usr/share/nginx/html;
        index index.html;

        location /chatHub {
            proxy_pass http://chat_backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }

        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
```

- [ ] **Step 3: Trocar o serviço Nginx no docker-compose para buildar a partir do Dockerfile**

`docker-compose.yml` (trecho a substituir — o serviço `nginx`):

```yaml
  nginx:
    build:
      context: .
      dockerfile: nginx/Dockerfile
    ports:
      - "80:80"
    depends_on:
      - backend1
      - backend2
      - backend3
```

- [ ] **Step 4: Subir o stack completo e validar**

Run: `docker compose up --build`

Abra `http://localhost/` (sem mais `test.html` — agora é o Angular real) em duas abas.

Expected: tela de entrada estilizada com PrimeNG, entra na sala, chat funciona em tempo
real entre as abas.

- [ ] **Step 5: Commit**

```bash
git add nginx/ docker-compose.yml
git commit -m "feat: nginx serve o build do Angular e faz proxy do websocket"
```

---

## Task 10: Validação end-to-end completa + README

**Files:**
- Create: `README.md` (raiz do repo)

**Interfaces:**
- Consumes: stack completo (Tasks 1-9).
- Produces: documentação de como rodar e validar o projeto.

- [ ] **Step 1: Executar o roteiro de validação completo do design**

Run: `docker compose up --build`

1. Abra `http://localhost/` em duas abas/perfis, entre na mesma sala com nomes diferentes.
2. Rode `docker compose logs -f` e confirme (pelo prefixo `[backendN]` nos logs) que as
   duas abas caíram em réplicas diferentes.
3. Mande mensagens nos dois sentidos, confirme entrega em tempo real e atualização da
   lista de online.
4. Descubra em qual réplica uma das abas está conectada (pelos logs) e rode
   `docker compose stop <essa-replica>`. Confirme que só aquela aba perde a conexão — a
   outra continua funcionando normalmente.

- [ ] **Step 2: Escrever o README**

`README.md`:

```markdown
# Web Chat — Docker + SignalR + Redis

Projeto de estudo: chat em tempo real com múltiplas réplicas de backend sincronizadas via
Redis pub/sub (SignalR backplane), atrás de um load balancer Nginx, tudo orquestrado por
Docker Compose.

Documentação completa da arquitetura e decisões:
[`docs/superpowers/specs/2026-09-03-chat-tempo-real-design.md`](docs/superpowers/specs/2026-09-03-chat-tempo-real-design.md).

## Rodando o projeto

```bash
docker compose up --build
```

Abra `http://localhost/`.

## Provando a arquitetura de escala

```bash
docker compose logs -f
```

Abra o chat em duas abas/perfis diferentes, entre na mesma sala e mande mensagens — os
logs mostram o caminho de cada mensagem entre réplicas via Redis (prefixo `[backendN]`
identifica qual réplica processou cada evento).

## Stack

- Backend: ASP.NET Core + SignalR (.NET 9)
- Sincronização entre réplicas: Redis (backplane do SignalR + armazenamento de presença)
- Frontend: Angular + PrimeNG (tema Aura)
- Load balancer / gateway: Nginx
- Orquestração: Docker Compose (3 réplicas nomeadas do backend: `backend1`, `backend2`, `backend3`)

## Limitações conhecidas (fora de escopo deliberado)

- Sem autenticação e sem persistência de histórico de mensagens.
- Se uma réplica cair, a reconexão automática do SignalR pode conectar o cliente em outra
  réplica, mas ele não reentra automaticamente na sala (`JoinRoom` não é reinvocado no
  evento de reconexão) — melhoria possível para uma iteração futura.
- Rodado apenas localmente; sem deploy em nuvem.

## Trabalho futuro

- Segundo frontend em React consumindo o mesmo backend (aprender React isoladamente,
  reaproveitando toda a infra já pronta).
- Persistência de histórico (Postgres) e autenticação, se o projeto evoluir.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README com instrucoes de execucao e validacao"
```
