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
