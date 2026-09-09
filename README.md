# Web Chat

Chat em tempo real por WebSocket, escalado horizontalmente em três réplicas de backend
sincronizadas por Redis, atrás de um load balancer Nginx. O projeto existe para tornar
**visível** o que normalmente é invisível: o caminho que uma mensagem percorre entre
processos quando a aplicação não cabe mais numa máquina só.

**Aplicação publicada:** https://web-chat-u5ko.onrender.com

## O que este projeto demonstra

Um chat funcionando é a parte fácil. O que interessa aqui é a infraestrutura em volta:

- **Estado compartilhado entre processos.** Cada réplica só conhece as próprias conexões.
  Uma mensagem enviada por quem está no Servidor A precisa alcançar quem está no C, e é o
  Redis, como backplane do SignalR, que faz essa ponte.
- **Balanceamento de conexões longas.** WebSocket fica aberto por horas, o que muda a
  estratégia certa de balanceamento em relação a requisições HTTP curtas.
- **Presença distribuída.** "Quem está online" não pode viver na memória de um processo,
  senão cada réplica responde uma coisa diferente.
- **Tolerância a falha.** Derrubar uma réplica não pode derrubar quem estava nela.

Para não deixar isso no campo da teoria, a aplicação tem um **visualizador de arquitetura ao
vivo**: um painel que desenha o Redis, as três réplicas, o Nginx e as pessoas conectadas, e
anima cada mensagem percorrendo o caminho real, salto a salto.

## Arquitetura

```
                          navegador
                              |
                              | WebSocket
                              v
                      +---------------+
                      |     Nginx     |   load balancer (least_conn)
                      +---------------+
                        /      |      \
                       v       v       v
                +---------+ +--------+ +--------+
                | Servidor| |Servidor| |Servidor|   processos independentes,
                |    A    | |    B   | |    C   |   cada um com seu estado
                +---------+ +--------+ +--------+
                       \       |       /
                        v      v      v
                      +---------------+
                      |     Redis     |   backplane, presença e histórico
                      +---------------+
```

Uma mensagem enviada na Sala Geral sobe da pessoa até o Nginx, dele até a réplica que atende
aquela conexão, e dali para o Redis. O Redis então a devolve para **todas** as réplicas com
gente conectada, inclusive a de origem, e cada uma entrega às suas próprias conexões.

Esse detalhe da réplica de origem receber a própria mensagem de volta é contraintuitivo, e foi
confirmado lendo o código-fonte do `RedisHubLifetimeManager`: `SendGroupAsync` apenas publica
no Redis, sem nenhum atalho de entrega local. O visualizador reflete esse comportamento real,
não uma simplificação.

## Rodando localmente

```bash
docker compose up --build
```

Abra `http://localhost/`. Sobem cinco containers: Redis, três réplicas do backend e o Nginx,
que também serve o frontend já compilado.

Para acessar de outro aparelho na mesma rede, use o IP da máquina no lugar de `localhost`.

## Vendo a escala funcionar

Abra o chat em duas abas com nomes diferentes. O selo no cabeçalho mostra em qual servidor
cada uma caiu, e o visualizador mostra as duas em réplicas diferentes. Mande uma mensagem e
acompanhe o pulso subindo até o Redis e descendo para as outras réplicas.

Para ver a tolerância a falha, com o chat aberto derrube a réplica onde você está:

```bash
docker compose kill backend1
```

A conexão cai, o selo pisca em âmbar, e em seguida você reaparece em outro servidor com as
mensagens preservadas. Em cerca de quinze segundos, a presença que ficou órfã na réplica morta
some do visualizador sozinha.

## Decisões técnicas

**`least_conn` em vez de round-robin.** Round-robin distribui bem requisições curtas, mas
WebSocket fica aberto por muito tempo: quem desconecta não libera vaga nenhuma no rodízio, e o
desequilíbrio só cresce. `least_conn` manda cada conexão nova para quem tem menos conexões
abertas agora. Não é sticky session: a escolha é por contagem, não por identidade do cliente.

**Conexão sem negociação prévia.** O cliente usa `skipNegotiation` com transporte WebSocket
puro. Sem isso, o SignalR faz um `POST /negotiate` separado antes do upgrade, e sem sticky
session o Nginx pode mandar as duas requisições para réplicas diferentes: a segunda rejeita a
conexão porque o `connectionId` só existe na memória de quem negociou. Pulando a negociação, a
conexão vira uma requisição atômica.

**Presença como contador, não como lista.** A presença é um hash `usuário -> número de
conexões`, atualizado por scripts Lua atômicos. Isso resolve duas coisas de uma vez: várias
abas da mesma pessoa (ela só some quando a última cai) e a corrida do F5 entre réplicas
diferentes, em que a conexão nova entra antes de a antiga sair.

**Failover exigiu duas peças, não uma.** Quando um processo morre de repente, ele não roda
`OnDisconnectedAsync`, e a presença de quem estava nele fica registrada sem conexão por trás.
A primeira peça é um sinal de vida: cada réplica se anuncia a cada cinco segundos, e as demais
limpam a presença de quem parou de responder. Só que isso não bastou. A réplica morta ainda
conta como viva até o sinal vencer, e a reconexão automática começa imediatamente, então a
pessoa batia no registro que ela própria tinha deixado e era recusada com "esse nome já está
em uso". A segunda peça é um identificador estável por aba, que muda a pergunta de "esse nome
existe?" para "esse nome pertence a outro?".

**Histórico deliberadamente curto.** A Sala Geral guarda as últimas cinquenta mensagens numa
lista Redis, só para recarregar a página não cair numa tela vazia. Conversa privada não é
guardada: armazenar conteúdo endereçado a uma pessoa é outra decisão, com outras implicações,
e o projeto trata mensagem privada como anônima até no visualizador, que recebe apenas os
nomes das réplicas envolvidas, sem remetente nem conteúdo.

**Sem biblioteca de componentes.** Botão, campo de texto e ícones são escritos no próprio
projeto, usando as mesmas variáveis de tema do resto da interface. Os avatares são gerados no
navegador a partir do nome, sem nenhuma chamada de rede, então a mesma pessoa tem sempre o
mesmo rosto.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | ASP.NET Core 10 com SignalR |
| Sincronização | Redis, como backplane do SignalR, presença e histórico |
| Frontend | Angular com Signals, sem biblioteca de componentes |
| Load balancer | Nginx com `least_conn` |
| Orquestração | Docker Compose, três réplicas nomeadas |
| Testes | xUnit e Moq no backend |

## Limitações conhecidas

Escolhas conscientes, não pendências esquecidas:

- Sem autenticação. "Nome de usuário" é só um texto digitado, sem senha.
- Sem persistência real. Tudo vive no Redis e some com ele.
- Mensagem privada para alguém que caiu bem na hora do envio não chega: não há fila, nova
  tentativa, nem aviso de falha para quem enviou.
- A topologia é fixa em três réplicas. O projeto é um estudo de escala horizontal, não um
  sistema com número variável de instâncias.

## Deploy

O `render.yaml` na raiz descreve o deploy no plano gratuito do Render. Nesse plano um serviço
pode fazer requisições na rede privada mas não pode recebê-las, então o Nginx não alcançaria
as réplicas por dentro se elas fossem serviços separados. Por isso o `Dockerfile.render`
empacota Nginx, as três réplicas e o Redis num container só, mantendo a mesma topologia
interna que o `docker-compose.yml` monta localmente: processos independentes, backplane real,
balanceador real.

O `render/start.sh` sobe as peças na ordem e derruba tudo se qualquer uma morrer, para o
serviço reiniciar num estado coerente em vez de servir um chat com réplicas mortas.

Vale saber ao abrir o link publicado: instâncias gratuitas hibernam após quinze minutos de
inatividade, então o primeiro acesso depois de um tempo parado demora.

## Documentos de design

Os documentos que embasaram cada ciclo do projeto estão em [`docs/design/`](docs/design/).
