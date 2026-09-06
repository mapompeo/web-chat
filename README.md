# Web Chat: Docker + SignalR + Redis

Projeto de estudo: chat em tempo real com múltiplas réplicas de backend sincronizadas via
Redis pub/sub (SignalR backplane), atrás de um load balancer Nginx, tudo orquestrado por
Docker Compose.

Documentação completa da arquitetura e decisões:
[`docs/superpowers/specs/2026-09-03-chat-tempo-real-design.md`](docs/superpowers/specs/2026-09-03-chat-tempo-real-design.md)
(design original) e
[`docs/superpowers/specs/2026-09-04-geral-privado-visual-design.md`](docs/superpowers/specs/2026-09-04-geral-privado-visual-design.md)
(sala geral, chat privado, .NET 10 e redesign visual).

## Rodando o projeto

```bash
docker compose up --build
```

Abra `http://localhost/`.

## Sala Geral e chat privado

Ao entrar, basta digitar um nome; não existe mais campo de "nome da sala". Toda conexão
entra automaticamente na **Sala Geral**, uma sala pública única compartilhada por todo mundo
que está online. A lista de conversas mostra a Sala Geral e, abaixo dela, cada usuário
online no momento.

Clicar no nome de outra pessoa abre uma **conversa privada 1:1** com ela, roteada via
`Clients.User(...)` do SignalR (identidade da conexão associada ao nome digitado). Mensagens
privadas não passam pelo grupo da Sala Geral e não aparecem pra mais ninguém além dos dois
participantes.

## Provando a arquitetura de escala

```bash
docker compose logs -f
```

Abra o chat em duas abas/perfis diferentes (as duas caem direto na Sala Geral, sem precisar
digitar nome de sala) e mande mensagens. Os logs mostram o caminho de cada mensagem entre
réplicas via Redis (prefixo `[backendN]` identifica qual réplica processou cada evento);
o mesmo vale pra mensagens privadas, que também podem ser entregues por uma réplica diferente
da que o destinatário conectou.

## Tema claro/escuro

A interface é escura por padrão, com um botão de alternância (ícone de sol/lua) que troca
para o tema claro. A escolha fica salva em `localStorage` e persiste entre recarregamentos.

## Stack

- Backend: ASP.NET Core + SignalR (.NET 10)
- Sincronização entre réplicas: Redis (backplane do SignalR + armazenamento de presença,
  com TTL de 4h nas chaves de presença, ver limitações abaixo)
- Frontend: Angular + PrimeNG (tema Aura, dark-first)
- Load balancer / gateway: Nginx
- Orquestração: Docker Compose (3 réplicas nomeadas do backend: `backend1`, `backend2`, `backend3`)

## Limitações conhecidas (fora de escopo deliberado)

- Sem autenticação e sem persistência de histórico de mensagens; recarregar a página (F5)
  limpa as conversas visíveis (Geral e privadas), embora a conexão em si se recupere sozinha
  (ver próximo ponto). Duas pessoas com o mesmo nome colidem, já que "nome de usuário" é só
  um texto digitado, sem senha.
- Se uma réplica cair, a reconexão automática do SignalR reconecta o cliente (possivelmente
  em outra réplica) e a Sala Geral é reentrada sozinha, porque `OnConnectedAsync` sempre
  adiciona a conexão à Sala Geral, em toda conexão nova, inclusive reconexões. Validado na
  prática: ao recarregar uma aba em Chrome, o backend registra a saída da conexão antiga e a
  entrada da nova (em outra réplica) e o usuário volta a aparecer sozinho na lista de online,
  sem duplicidade. A única coisa que se perde no reload é o estado local de UI (histórico de
  mensagens exibido), não a participação na sala.
- Mensagem privada mandada pra alguém que caiu da conexão bem na hora do envio simplesmente
  não chega: não há fila, retry, nem notificação de falha pro remetente.
- A presença (lista de "quem está online") usa uma chave Redis com TTL de 4h como rede de
  segurança, não um heartbeat de verdade; se o processo do backend morrer sem rodar
  `OnDisconnectedAsync`, o usuário some da lista só quando o TTL expirar, não instantaneamente.
- Rodado apenas localmente; sem deploy em nuvem.

## Trabalho futuro

- Persistência de histórico (Postgres) e autenticação real, se o projeto evoluir.
- Indicador de "digitando..." nas conversas privadas.
- Segundo frontend em React consumindo o mesmo backend (aprender React isoladamente,
  reaproveitando toda a infra já pronta).
