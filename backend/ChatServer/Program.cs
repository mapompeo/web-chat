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
