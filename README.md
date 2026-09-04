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
