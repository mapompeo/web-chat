# Design: Sala Geral, Chat Privado, Atualização de .NET e Redesign Visual

**Data**: 2026-09-04
**Status**: Aprovado para planejamento
**Tipo**: Segundo ciclo de melhorias sobre o projeto de estudo existente

## Objetivo

Este é o segundo ciclo de trabalho sobre o chat em tempo real (ver
[`2026-09-03-chat-tempo-real-design.md`](2026-09-03-chat-tempo-real-design.md) para o design
original). Quatro mudanças, todas decididas em conversa com o usuário:

1. Atualizar o backend de .NET 9 para a versão mais recente disponível (.NET 10), instalando o
   SDK se necessário.
2. Substituir o modelo de "digite o nome de uma sala" por uma **Sala Geral única e fixa**, que
   todo mundo entra automaticamente.
3. Adicionar **chat privado (um-a-um)**: a partir da lista de quem está online, a pessoa escolhe
   alguém e abre uma conversa só entre os dois.
4. Redesenhar o visual do frontend: tema escuro por padrão (estilo "Minimal/Linear" — fundo quase
   preto, bordas discretas, acento azul-elétrico) com botão para alternar pra um tema claro.

Junto com isso, três itens pendentes do ciclo anterior entram neste plano:

- Presença no Redis ganha expiração (TTL), pra usuários não ficarem "fantasmas" na lista de
  online depois de uma queda abrupta do servidor.
- Remover `backend/ChatServer/wwwroot/test.html` (página de teste manual do primeiro ciclo,
  virou código morto desde que o Nginx passou a servir o Angular).
- Corrigir duas rugosidades de UX introduzidas no fix final do ciclo anterior: possível
  sobrescrita do rascunho de mensagem numa corrida rara, e o aviso de erro que não some sozinho
  depois de uma ação bem-sucedida.

## Fora de escopo (deliberadamente)

- Histórico de mensagens privadas (continuam efêmeras, sem persistência — mesma filosofia do
  chat em grupo hoje).
- Autenticação de verdade (o "nome de usuário" continua sendo só o que a pessoa digita, sem
  senha; ver Limitações).
- Notificação/retry se a mensagem privada for enviada bem no instante em que a outra pessoa cai
  da conexão — a mensagem simplesmente não chega (consistente com "sem histórico").

## Arquitetura

### A ideia central

Em vez de construir um sistema de chat privado do zero, o design reaproveita ao máximo o que já
existe (Hub, Redis, réplicas) e usa um recurso do próprio SignalR que ainda não estava em uso:
**entrega de mensagem direcionada a um usuário específico** (`Clients.User(...)`), que já
funciona corretamente entre réplicas diferentes porque usa o mesmo backplane Redis configurado
desde o ciclo anterior — não é mecanismo novo, é uma peça do SignalR que passamos a acionar.

Isso resolve elegantemente o problema de "como o Bob recebe uma mensagem da Ana sem nunca ter
clicado nela antes": a entrega não depende de os dois estarem "na mesma sala" — depende só de o
Bob estar conectado, em qualquer réplica.

### Identidade da conexão

Hoje, o cliente só informa seu nome *depois* de conectar (numa chamada de método do Hub,
`JoinRoom`). Para o `Clients.User(...)` funcionar, o SignalR precisa saber "quem é esta conexão"
**no momento da conexão em si**, via uma peça chamada `IUserIdProvider`.

Mudança: o cliente passa o nome de usuário na própria URL de conexão
(`/chatHub?user=Ana`), e um `IUserIdProvider` customizado lê esse valor. Isso substitui a
identificação-depois-de-conectar por identificação-no-momento-de-conectar — mais simples, e é o
que viabiliza tudo o resto.

### Sala Geral

- Ao conectar (com o nome já identificado), a conexão é automaticamente colocada no grupo
  `"Geral"` e adicionada à presença daquele grupo (reaproveitando o `IRoomPresenceService` já
  existente, sem mudança nele) — isso acontece em `OnConnectedAsync`, não precisa mais de uma
  chamada explícita `JoinRoom` do cliente.
- `SendMessage(message)` perde o parâmetro `roomName` (só existe uma sala agora) e transmite
  pro grupo `"Geral"`, exatamente como a sala custom fazia antes.
- Ao desconectar, `OnDisconnectedAsync` remove a presença e avisa o grupo — mesma lógica de
  antes, só que sempre para `"Geral"`.

### Chat privado

- Não existe "entrar" numa conversa privada do lado do servidor — é só enviar e receber.
- Novo método no Hub: `SendPrivateMessage(string toUserName, string message)`. Usa
  `Context.UserIdentifier` pra saber quem está mandando, e chama
  `Clients.User(toUserName).SendAsync("ReceivePrivateMessage", ...)` pra entregar — só pro
  destinatário, sem ecoar de volta pro remetente. A própria aba de quem manda já sabe o que
  acabou de escrever e pra quem, então ela mesma adiciona a mensagem na sua tela assim que o
  envio é confirmado pelo servidor (sem precisar que o servidor "devolva" a mensagem — isso
  evita ambiguidade: um eco não carregaria a informação de "pra quem eu mandei", só "quem
  mandou").
- Do lado do cliente: quando a pessoa clica num nome na lista de online, abre-se localmente um
  painel de conversa com aquela pessoa (não é um "join" no servidor, é só UI). Se uma mensagem
  privada chegar de alguém que ainda não tem um painel aberto, o painel é criado automaticamente
  — do jeito que qualquer app de DM se comporta.

### Por que a conexão não precisa mais rastrear "em qual sala estou"

O ciclo anterior tinha uma limitação conhecida: `Context.Items` só guardava uma sala por conexão.
Com o redesenho, isso deixa de ser um problema — a Sala Geral é permanente pra vida da conexão
(nunca se "sai" dela), e o chat privado nunca depende de grupo/sala nenhuma. Resultado:
`Context.Items` não precisa mais existir no Hub.

## Componentes

| Componente | Mudança |
|---|---|
| `ChatHub.cs` | `OnConnectedAsync` novo (auto-join Geral); `JoinRoom` removido; `SendMessage` perde `roomName`; `SendPrivateMessage` novo |
| `IUserIdProvider` customizado | Novo — lê o usuário da query string da conexão |
| `Program.cs` | Registra o `IUserIdProvider` customizado |
| `IRoomPresenceService` / `RedisRoomPresenceService` | Sem mudança de interface — ganha expiração (TTL) nas chaves do Redis |
| `ChatService` (Angular) | `connect(userName)` agora recebe o nome e monta a URL com `?user=`; ganha `sendPrivateMessage()`; passa a rastrear múltiplas conversas (Geral + privados abertos), não só uma |
| `JoinRoomComponent` | Simplifica pra só pedir o nome (remove o campo de nome de sala) |
| `ChatRoomComponent` | Vira a tela da Sala Geral; ganha a barra lateral de "quem está online" clicável |
| Novo: painel de conversa privada | Componente novo, populado a partir do clique num nome online ou de uma mensagem privada recebida |
| Tema (PrimeNG) | Paleta escura (padrão) + paleta clara, com botão de alternância persistido no navegador |
| `backend/ChatServer/wwwroot/test.html` | Removido |
| `.csproj` (backend, 2x), Dockerfiles (backend, nginx) | `net9.0` → `net10.0`, imagens Docker `sdk:9.0`/`aspnet:9.0` → `10.0` |

## Fluxo de dados: mensagem privada

1. Ana e Bob estão online (cada um numa réplica, possivelmente diferente).
2. Ana clica em "Bob" na lista de online → abre um painel de conversa privada com ele (só na
   tela dela, servidor não sabe disso ainda).
3. Ana digita e manda "oi Bob!".
4. O Hub (na réplica da Ana) recebe `SendPrivateMessage("Bob", "oi Bob!")`, identifica a
   remetente via `Context.UserIdentifier` ("Ana"), e chama `Clients.User("Bob").SendAsync(...)`.
5. O SignalR, via o backplane Redis já configurado, entrega a mensagem pra conexão do Bob —
   esteja ela na mesma réplica da Ana ou não.
6. O cliente do Bob recebe `ReceivePrivateMessage("Ana", "oi Bob!", ...)`. Se ele não tinha um
   painel aberto com a Ana, um é criado automaticamente.

## Visual (tema escuro por padrão)

Paleta base (estilo "Minimal/Linear", aprovada via mockup interativo):

**Escuro (padrão)**: fundo `#0e0f11`, superfícies `#17181b`, bordas `#26272b`, texto `#e4e4e7`,
texto secundário `#a1a1aa`, acento `#5b8cff` (botões, balão de mensagem própria, indicador
online).

**Claro (alternável)**: fundo `#ffffff`, superfícies `#f4f4f5`, bordas `#e4e4e7`, texto
`#18181b`, texto secundário `#71717a`, acento `#3b6fe0`.

A preferência de tema fica salva no navegador da pessoa (não precisa de servidor pra lembrar).
Paleta exata pode ser refinada durante a implementação usando o sistema de temas do PrimeNG.

## Testes / validação

Mesma filosofia do ciclo anterior — validação manual num navegador real é a prova principal, não
uma suíte de testes automatizados extensa:

- Testes de unidade do Hub (xUnit) são reescritos pra cobrir o novo formato de `SendMessage`
  (sem `roomName`) e o novo `SendPrivateMessage` (mockando `Clients.User(...)`).
- Validação manual: duas abas, confirmar Sala Geral funcionando, abrir conversa privada entre
  elas, confirmar entrega cruzada de réplica (do jeito que já provamos no ciclo anterior), e
  confirmar que uma mensagem privada chega mesmo sem a outra pessoa ter aberto o painel antes.

## Limitações conhecidas (deliberadas, não corrigidas neste ciclo)

- Sem autenticação: o "nome de usuário" é só um texto digitado, sem senha. Duas pessoas com o
  mesmo nome colidem (limitação herdada do ciclo anterior, ainda fora de escopo).
- Mensagem privada mandada pra alguém que caiu da conexão no mesmo instante simplesmente não
  chega — sem fila, sem retry, sem notificação de falha pro remetente.
- Sem histórico: recarregar a página limpa as conversas (Geral e privadas).

## Trabalho futuro (fora deste ciclo)

- Persistência de histórico (banco de dados), se o projeto evoluir além do escopo de estudo.
- Autenticação real, pra resolver a colisão de nomes.
- Indicador de "digitando..." nas conversas privadas.
