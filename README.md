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
- Frontend: Angular (escuro por padrão), sem biblioteca de componentes: botão, campo de
  texto e ícones são escritos no próprio projeto, usando as mesmas variáveis de tema
- Avatares: DiceBear, gerados no navegador a partir do nome, sem chamada de rede
- Load balancer / gateway: Nginx, com `least_conn`
- Orquestração: Docker Compose (3 réplicas nomeadas do backend: `backend1`, `backend2`, `backend3`)

## Limitações conhecidas (fora de escopo deliberado)

- Sem autenticação e sem persistência de histórico de mensagens; recarregar a página (F5)
  limpa as conversas visíveis (Geral e privadas), embora a conexão em si se recupere sozinha
  (ver próximo ponto). Duas pessoas com o mesmo nome colidem, já que "nome de usuário" é só
  um texto digitado, sem senha.
- Ao recarregar a aba (F5), a reconexão funciona: o backend registra a saída da conexão
  antiga e a entrada da nova (possivelmente em outra réplica), e a Sala Geral é reentrada
  sozinha, porque `OnConnectedAsync` sempre adiciona a conexão à Sala Geral, em toda conexão
  nova. Só se perde o estado local de interface (histórico exibido), não a participação.
- **A queda de uma réplica, porém, hoje expulsa quem estava nela.** Quando o processo morre
  de repente, ele não roda `OnDisconnectedAsync`, então a presença daquela pessoa fica órfã
  no Redis. A reconexão automática cai em outra réplica, a checagem de nome único encontra o
  registro órfão e recusa a entrada com "esse nome já está em uso", e o cliente encerra a
  conexão. Ou seja, derrubar uma réplica não produz failover; produz expulsão. A correção
  seria trocar a pergunta "esse nome existe na presença?" por "esse nome está numa réplica
  que ainda está viva?", com um heartbeat curto por réplica no Redis. Está mapeado e ainda
  não foi feito.
- Mensagem privada mandada pra alguém que caiu da conexão bem na hora do envio simplesmente
  não chega: não há fila, retry, nem notificação de falha pro remetente.
- A presença (lista de "quem está online") usa uma chave Redis com TTL de 4h como rede de
  segurança, não um heartbeat de verdade; se o processo do backend morrer sem rodar
  `OnDisconnectedAsync`, o usuário some da lista só quando o TTL expirar, não instantaneamente.
  Um efeito colateral disso vale conhecer ao olhar o visualizador: ele desenha a presença
  registrada no Redis, enquanto o `least_conn` do Nginx decide pelas conexões TCP que ele
  mantém abertas. São contagens diferentes, e conforme fantasmas se acumulam elas divergem,
  fazendo o balanceador parecer errado quando está certo. `docker compose restart` limpa.

## Deploy

O `render.yaml` na raiz descreve um deploy no plano gratuito do Render: no painel, em
Blueprints, aponte para este repositório e o serviço é criado sem mais configuração.

É um único web service, e não cinco, porque no plano gratuito um web service pode fazer
requisições na rede privada mas **não pode recebê-las** (e Private Services são pagos), então
o Nginx não teria como alcançar as réplicas por dentro; e porque a cota é de 750 horas de
instância por mês no workspace inteiro, o que mantém uma instância ligada o tempo todo, não
cinco. O `Dockerfile.render` empacota Nginx, as três réplicas e o Redis no mesmo container,
e o `render/start.sh` sobe as peças na ordem e derruba tudo se qualquer uma morrer.

As réplicas deixam de estar em máquinas separadas, mas continuam sendo três processos
independentes, cada um com seu estado em memória, conversando por um backplane Redis real
atrás de um balanceador real: a mesma topologia que o `docker-compose.yml` monta localmente.
Medido rodando a imagem com os limites do plano gratuito (512MB): 94MB em uso com três
pessoas conectadas, e as conexões distribuídas uma em cada réplica.

## Trabalho futuro

- Persistência de histórico (Postgres) e autenticação real, se o projeto evoluir.
- Indicador de "digitando..." nas conversas privadas.
- Segundo frontend em React consumindo o mesmo backend (aprender React isoladamente,
  reaproveitando toda a infra já pronta).
