# Design: Chat em Tempo Real com Docker + SignalR + Redis

**Data**: 2026-09-03
**Status**: Aprovado para planejamento
**Tipo**: Projeto de estudo (portfolio)

## Objetivo

Projeto de estudo com foco duplo: **Docker** (orquestração de múltiplos containers, rede
entre serviços) e **comunicação em tempo real via WebSocket** (SignalR). O artefato de
demonstração é um chat simples; o valor de aprendizado real está na arquitetura de escala
por trás dele: múltiplas réplicas de um servidor stateful sincronizadas via Redis pub/sub,
atrás de um load balancer.

Este NÃO é um projeto para produção nem para maximizar funcionalidades de chat. É
deliberadamente pequeno na superfície (features) e deliberadamente "grande demais" na
infraestrutura, de propósito, para forçar o aprendizado do padrão de escala horizontal de
conexões persistentes: um padrão que, em escala real, é usado por sistemas como Slack,
Discord, WhatsApp Web.

## Escopo (MVP)

**Funcionalidades do chat, nível intermediário:**
- Múltiplas salas de chat (usuário escolhe/cria uma sala ao entrar).
- Lista de "quem está online" na sala atual, atualizada em tempo real.
- Envio/recebimento de mensagens em tempo real dentro da sala.
- Sem autenticação (usuário só informa um nome de exibição).
- Sem persistência (mensagens não sobrevivem a um restart, propositalmente fora de escopo).

**Fora de escopo (explicitamente, para não desviar do foco):**
- Login/autenticação real.
- Histórico de mensagens em banco de dados.
- Mensagens privadas (DM), edição/exclusão de mensagens, anexos.
- Deploy em nuvem (o projeto roda 100% local via Docker Compose).
- Frontend em React, ver seção "Trabalho futuro".

## Arquitetura

```
                        ┌─────────────┐
   Browser (Angular) ──▶│    Nginx    │  (load balancer)
                        └──────┬──────┘
                 ┌─────────────┼─────────────┐
                 ▼             ▼             ▼
           ┌──────────┐  ┌──────────┐  ┌──────────┐
           │ Réplica 1│  │ Réplica 2│  │ Réplica 3│   (.NET + SignalR Hub)
           └────┬─────┘  └────┬─────┘  └────┬─────┘
                 └─────────────┼─────────────┘
                                ▼
                          ┌──────────┐
                          │  Redis   │  (backplane pub/sub)
                          └──────────┘
```

Todos os serviços rodam como containers Docker distintos, orquestrados por um único
`docker-compose.yml`, numa rede interna do Docker.

### Componentes

| Componente | Tecnologia | Papel |
|---|---|---|
| Frontend | Angular + PrimeNG (tema Aura) | UI do chat: entrar em sala, ver mensagens, ver quem está online |
| Backend (× 3 réplicas) | ASP.NET Core + SignalR Hub | Lógica do chat: grupos (salas), broadcast de mensagens, presença online |
| Backplane | Redis (`Microsoft.AspNetCore.SignalR.StackExchangeRedis`) | Sincroniza mensagens/eventos de presença entre réplicas |
| Load Balancer | Nginx | Distribui conexões WebSocket entre as 3 réplicas |
| Orquestração | Docker Compose | Sobe todos os containers com um comando, define rede interna |

Cada réplica do backend é a build **da mesma imagem Docker**, não há código diferente
entre elas. O `docker-compose.yml` declara 3 serviços nomeados explicitamente
(`backend1`, `backend2`, `backend3`, todos a partir da mesma imagem), em vez de usar
`deploy.replicas`, porque nomes fixos deixam os logs mais fáceis de identificar por
réplica durante o aprendizado (`docker compose logs -f backend2`, por exemplo).

### Fluxo de dados: enviar uma mensagem

1. UserA está conectado (via WebSocket) na Réplica 1. UserB está conectado na Réplica 2.
   Ambos estão na mesma sala ("Sala X").
2. UserA envia "oi" → chega só na Réplica 1 (única com a conexão WebSocket dele aberta).
3. Réplica 1 executa `Clients.Group("Sala X").SendAsync(...)` no Hub do SignalR.
4. O backplane Redis, configurado automaticamente pelo SignalR, publica esse evento no
   canal do Redis associado à Sala X.
5. Réplica 2 (e Réplica 3), inscritas nesse canal, recebem o evento do Redis.
6. Réplica 2 entrega "oi" para os clientes dela que estão no grupo "Sala X", inclusive
   UserB.
7. Resultado: UserA e UserB, conectados em réplicas diferentes, veem a mesma mensagem.

O mesmo mecanismo vale para entrar/sair de sala (evento de presença), que atualiza a
lista de "quem está online" em todas as réplicas.

### Load balancing e WebSocket

WebSocket é uma conexão de longa duração (não é request/response como HTTP comum). O
Nginx precisa ser configurado para:
- Fazer upgrade de conexão HTTP → WebSocket (`proxy_set_header Upgrade`, `Connection`).
- Usar uma estratégia de distribuição simples (round-robin, o padrão do Nginx), a conexão
  abre uma vez e persiste na réplica escolhida até ser fechada. Não precisamos de *sticky
  sessions* porque o Redis backplane já resolve a sincronização entre réplicas
  independentemente de qual réplica cada cliente está.

**Detalhe importante do lado do cliente:** por padrão, o cliente do SignalR faz uma
etapa de *negociação*: um `POST /chatHub/negotiate` separado, que devolve um
`connectionId`, **antes** de abrir a conexão WebSocket de verdade. Sem sticky
sessions, o Nginx pode mandar esse `POST /negotiate` pra uma réplica e o upgrade de
WebSocket subsequente pra outra, e como o `connectionId` só existe na memória da
réplica que o gerou, a segunda réplica rejeita a conexão (erro citando "sticky
sessions"). A solução não é reintroduzir sticky sessions (isso voltaria a depender
do roteamento, o que é exatamente o que este projeto quer evitar), é configurar o
cliente para **pular a negociação** e ir direto de WebSocket
(`skipNegotiation: true` + `transport: HttpTransportType.WebSockets` no
`HubConnectionBuilder`). Com isso, cada conexão vira uma única requisição atômica
de upgrade: não há mais um `connectionId` pré-negociado em outra réplica pra dar
errado, e round-robin sem stickiness volta a ser 100% correto. Essa opção exige que
o cliente sempre suporte WebSocket nativo (verdade para qualquer navegador moderno,
o que cobre este projeto).

### Observabilidade (para o aprendizado, não para produção)

Cada réplica loga, com prefixo identificando ela mesma (ex: `[Réplica 2]`), eventos-chave:
conexão aberta, mensagem recebida, mensagem publicada no Redis, mensagem recebida via
Redis, mensagem entregue a um cliente. Isso permite rodar `docker compose logs -f` e
literalmente ver o caminho de uma mensagem pulando entre containers, é o principal
artefato de aprendizado do projeto.

## Estrutura do projeto

```
signalr-docker-chat/
├── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── backend/                  # ASP.NET Core + SignalR, uma única imagem/projeto
│   ├── Dockerfile
│   └── ...
├── frontend/                 # Angular + PrimeNG
│   ├── Dockerfile
│   └── ...
└── docs/superpowers/specs/   # este documento e futuros
```

## Testes / validação

Não é um projeto com suíte de testes automatizados como foco (o foco é infraestrutura,
não qualidade de código de produção). A validação principal é manual e visual:

1. Subir `docker compose up` (os 3 serviços de backend já sobem juntos).
2. Abrir o frontend em duas abas/navegadores diferentes, entrar na mesma sala.
3. Confirmar via logs (`docker compose logs -f`) que as duas conexões caíram em réplicas
   diferentes.
4. Mandar mensagem de uma aba, confirmar que aparece na outra, e observar nos logs o
   caminho completo (réplica origem → Redis → réplica destino).
5. Matar (`docker stop`) uma réplica no meio de uma conversa e confirmar que só os
   usuários daquela réplica são desconectados, os demais continuam funcionando.

Um teste de unidade simples no Hub do SignalR (ex: lógica de entrar/sair de grupo) é
desejável mas não bloqueante para o MVP.

## Trabalho futuro (fora deste projeto)

- **Frontend em React**: como o backend expõe SignalR via WebSocket (protocolo agnóstico
  de framework), um segundo frontend em React consumindo o mesmo backend é um bom
  "projeto parte 2" para aprender React isoladamente, sem reaprender a parte de infra.
- Persistência de histórico (Postgres) e autenticação, se o projeto evoluir além do
  estudo inicial.
- Deploy real em nuvem (ex: Azure Container Apps, que tem suporte nativo a SignalR
  Service gerenciado).
