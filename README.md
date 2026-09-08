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

- Sem autenticação: "nome de usuário" é só um texto digitado, sem senha.
- A Sala Geral guarda as últimas 50 mensagens no Redis, o suficiente para recarregar a
  página (F5) não cair numa tela vazia. Continua efêmero: a lista tem tamanho fixo, prazo de
  validade e some junto com o Redis. Conversa privada NÃO é guardada, de propósito, porque
  armazenar conteúdo endereçado a uma pessoa é outra decisão, com outras implicações; o
  projeto trata mensagem privada como anônima até no visualizador.
- Ao recarregar a aba (F5), a reconexão funciona: o backend registra a saída da conexão
  antiga e a entrada da nova (possivelmente em outra réplica), e a Sala Geral é reentrada
  sozinha, porque `OnConnectedAsync` sempre adiciona a conexão à Sala Geral, em toda conexão
  nova. Só se perde o estado local de interface (histórico exibido), não a participação.
- A queda de uma réplica é absorvida: quem estava nela reconecta em outra, sem perder as
  mensagens. Verificado matando o container com `docker compose kill`, que não dá ao processo
  a chance de encerrar de forma limpa. Isso exigiu duas peças, descritas em
  `Services/IReplicaRegistry.cs` e `Services/INameOwnershipService.cs`: cada réplica anuncia
  periodicamente que está viva e as demais limpam a presença órfã de quem parou de anunciar;
  e cada aba manda um identificador estável, para a checagem de nome único perguntar "esse
  nome pertence a outro?" em vez de "esse nome existe?". Sem a segunda peça, a reconexão
  (que começa imediatamente) batia no registro que a própria pessoa tinha acabado de deixar
  e era recusada com "esse nome já está em uso".
- Mensagem privada mandada pra alguém que caiu da conexão bem na hora do envio simplesmente
  não chega: não há fila, retry, nem notificação de falha pro remetente.
- A presença (lista de "quem está online") usa uma chave Redis com TTL de 4h como rede de
  segurança, não um heartbeat de verdade; se o processo do backend morrer sem rodar
  `OnDisconnectedAsync`, o usuário some da lista só quando o TTL expirar, não instantaneamente.
  Na prática isso é coberto pela varredura de réplicas mortas descrita acima, que remove a
  presença órfã em cerca de 15 segundos. Vale saber, ao comparar números: o visualizador
  desenha a presença registrada no Redis, enquanto o `least_conn` do Nginx decide pelas
  conexões TCP que ele mantém abertas, então são contagens de coisas diferentes.

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
