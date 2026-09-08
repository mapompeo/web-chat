using ChatServer.Hubs;
using ChatServer.Services;
using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var redisConnection = builder.Configuration["REDIS_CONNECTION"] ?? "localhost:6379";

builder.Services.AddSingleton<IConnectionMultiplexer>(
    ConnectionMultiplexer.Connect(redisConnection));
builder.Services.AddSingleton<IRoomPresenceService, RedisRoomPresenceService>();
builder.Services.AddSingleton<IReplicaRegistry, RedisReplicaRegistry>();
builder.Services.AddSingleton<IMessageHistoryService, RedisMessageHistoryService>();
builder.Services.AddSingleton<INameOwnershipService, RedisNameOwnershipService>();

// Anuncia periodicamente que esta replica esta viva e limpa a presenca das que
// pararam de responder. Sem isso, uma replica derrubada deixa quem estava nela
// preso na lista de online pra sempre, e a checagem de nome unico passa a
// recusar essas mesmas pessoas quando elas tentam reconectar.
builder.Services.AddHostedService<ReplicaHeartbeatService>();

builder.Services.AddSignalR()
    .AddStackExchangeRedis(redisConnection);

builder.Services.AddSingleton<IUserIdProvider, QueryStringUserIdProvider>();

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

app.UseCors("AllowFrontend");

app.MapHub<ChatHub>("/chatHub");

app.Run();
