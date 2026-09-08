import { Injectable, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';

export interface ChatMessage {
  userName: string;
  message: string;
  replica: string;
  timestamp: string;
}

export interface VisualizerPulse {
  id: string;
  kind: 'connect' | 'disconnect' | 'geral' | 'privada';
  replica?: string;           // connect/disconnect
  fromReplica?: string;       // geral/privada
  toReplicas?: string[];      // geral (leque) ou privada (pode ter mais de uma réplica)
  userName?: string;          // connect/disconnect/geral, nunca em privada
}

export type ConnectionState = 'conectando' | 'conectado' | 'reconectando' | 'desconectado';

@Injectable({ providedIn: 'root' })
export class ChatService {
  // Duração de cada "perna" da jornada do pulso no painel do visualizador:
  // precisa bater com HOP_MS em visualizer-panel.component.ts e com a duração
  // da animação em @keyframes viz-flow-down/viz-flow-up no styles.scss. Uma
  // mensagem percorre até 6 pernas (pessoa → nginx → servidor → redis → outro
  // servidor → nginx → outra pessoa); conectar/desconectar só percorre 2
  // (pessoa ↔ nginx ↔ servidor, nunca toca o Redis). O pulso só pode sumir da
  // tela depois que a última perna dele já tiver terminado de animar.
  private static readonly HOP_MS = 500;

  private connection?: signalR.HubConnection;

  readonly currentUserName = signal<string>('');
  readonly onlineUsers = signal<string[]>([]);
  readonly geralMessages = signal<ChatMessage[]>([]);
  readonly privateMessages = signal<Map<string, ChatMessage[]>>(new Map());
  readonly unreadPrivate = signal<Set<string>>(new Set());
  readonly replicaUsers = signal<Map<string, string[]>>(new Map());
  readonly visualizerPulses = signal<VisualizerPulse[]>([]);
  // Preenchido quando o servidor recusa a entrada (nome inválido ou já em
  // uso). Quem consome isso (ChatRoomComponent) precisa reagir de forma
  // reativa; start() já resolveu com sucesso antes desse evento chegar,
  // então não dá pra simplesmente capturar isso como um erro do connect().
  readonly joinError = signal<string | null>(null);

  // Qual das réplicas atendeu ESTA conexão, informado pelo servidor em
  // OnConnectedAsync. Volta pra null enquanto a conexão está caída: nesse
  // intervalo não há servidor nenhum atendendo, e ao reconectar o load
  // balancer escolhe de novo, então pode vir outro.
  readonly myReplica = signal<string | null>(null);
  readonly connectionState = signal<ConnectionState>('conectando');

  // Identificador da ABA, não da pessoa. O servidor usa isto pra saber que uma
  // conexão nova com um nome já ocupado é a mesma aba voltando (reconexão
  // automática depois de uma réplica cair) e não outra pessoa querendo o mesmo
  // nome. Fica em sessionStorage de propósito: sobrevive a recarregar a página
  // e à reconexão, mas cada aba tem o seu, então abrir uma segunda aba com o
  // mesmo nome continua sendo recusado, como antes.
  private static clientId(): string {
    const chave = 'chat-client-id';
    let id = sessionStorage.getItem(chave);
    if (!id) {
      id = ChatService.randomId();
      sessionStorage.setItem(chave, id);
    }
    return id;
  }

  // crypto.randomUUID() só existe em "contexto seguro", ou seja, HTTPS ou
  // localhost. Abrindo o chat pelo IP da máquina na rede local
  // (http://192.168.x.x), que é justamente como se testa em outro aparelho,
  // ela vem indefinida: chamar direto derrubava o connect() inteiro com
  // TypeError, e a tela de entrada mostrava isso como "não foi possível
  // conectar ao backend", apontando pro lugar errado. crypto.getRandomValues,
  // por outro lado, existe em qualquer contexto, e o valor só precisa ser
  // único por aba, não criptograficamente perfeito.
  private static randomId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  async connect(userName: string): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
    }

    this.currentUserName.set(userName);
    this.geralMessages.set([]);
    this.onlineUsers.set([]);
    this.privateMessages.set(new Map());
    this.unreadPrivate.set(new Set());
    this.replicaUsers.set(new Map());
    this.visualizerPulses.set([]);
    this.joinError.set(null);
    this.myReplica.set(null);
    this.connectionState.set('conectando');

    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente; a segunda
      // rejeita a conexão porque o connectionId só existe na réplica que negociou.
      // Pulando a negociação, a conexão vira uma única requisição atômica.
      .withUrl(`/chatHub?user=${encodeURIComponent(userName)}&client=${encodeURIComponent(ChatService.clientId())}`, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets
      })
      .withAutomaticReconnect()
      .build();

    this.connection.on('RoomJoined', (users: string[]) => {
      this.onlineUsers.set(users);
    });

    this.connection.on('ConnectedToReplica', (replica: string) => {
      this.myReplica.set(replica);
    });

    // As últimas mensagens da sala, mandadas pelo servidor assim que a conexão
    // entra. É o que faz recarregar a página (F5) não cair mais numa tela em
    // branco. Chega ANTES de qualquer "ReceiveMessage" ao vivo, porque o
    // servidor manda o histórico antes de colocar a conexão no grupo, então
    // aqui pode substituir a lista sem risco de apagar algo recém-chegado.
    this.connection.on('RoomHistory', (history: ChatMessage[]) => {
      this.geralMessages.set(history ?? []);
    });

    this.connection.on('UserJoined', (joinedUser: string) => {
      this.onlineUsers.update(users => users.includes(joinedUser) ? users : [...users, joinedUser]);
    });

    this.connection.on('UserLeft', (leftUser: string) => {
      this.onlineUsers.update(users => users.filter(u => u !== leftUser));
    });

    this.connection.on('ReceiveMessage', (fromUser: string, message: string, replica: string, timestamp: string) => {
      this.geralMessages.update(msgs => [...msgs, { userName: fromUser, message, replica, timestamp }]);
    });

    this.connection.on('ReceivePrivateMessage', (fromUser: string, message: string, replica: string, timestamp: string) => {
      this.privateMessages.update(map => {
        const next = new Map(map);
        const existing = next.get(fromUser) ?? [];
        next.set(fromUser, [...existing, { userName: fromUser, message, replica, timestamp }]);
        return next;
      });
      // Marca como não lida sempre; quem estiver com a conversa aberta na hora
      // limpa isso de volta imediatamente (ver efeito em ChatRoomComponent), então
      // na prática só fica marcado quem realmente não está olhando aquela conversa.
      this.unreadPrivate.update(set => new Set(set).add(fromUser));
    });

    this.connection.on('VisualizerSnapshot', (snapshot: Record<string, string[]>) => {
      this.replicaUsers.set(new Map(Object.entries(snapshot)));
    });

    this.connection.on('VisualizerUserConnected', (replica: string, connectedUser: string) => {
      this.replicaUsers.update(map => {
        const next = new Map(map);
        const users = next.get(replica) ?? [];
        if (!users.includes(connectedUser)) {
          next.set(replica, [...users, connectedUser]);
        }
        return next;
      });
      this.addPulse({ kind: 'connect', replica, userName: connectedUser });
    });

    this.connection.on('VisualizerUserDisconnected', (replica: string, disconnectedUser: string) => {
      this.replicaUsers.update(map => {
        const next = new Map(map);
        const users = next.get(replica) ?? [];
        next.set(replica, users.filter(u => u !== disconnectedUser));
        return next;
      });
      this.addPulse({ kind: 'disconnect', replica, userName: disconnectedUser });
    });

    this.connection.on('VisualizerGeralMessage', (fromReplica: string, geralUser: string, activeReplicas: string[]) => {
      this.addPulse({ kind: 'geral', fromReplica, toReplicas: activeReplicas, userName: geralUser });
    });

    this.connection.on('VisualizerPrivateMessage', (fromReplica: string, toReplicas: string[]) => {
      this.addPulse({ kind: 'privada', fromReplica, toReplicas });
    });

    this.connection.on('JoinRejected', (reason: string) => {
      this.joinError.set(reason);
      // Chamar stop() explicitamente (em vez de deixar a conexão cair
      // "sozinha") é o que impede o withAutomaticReconnect() de tentar de
      // novo; reconexão automática só dispara quando a conexão cai de
      // forma inesperada, nunca depois de um stop() intencional. Sem isso,
      // o cliente ficaria reconectando (e sendo recusado de novo) num loop
      // silencioso, sem nunca mostrar erro nenhum.
      void this.connection?.stop();
    });

    // A reconexão automática é o que torna a queda de uma réplica indolor: o
    // cliente refaz a conexão sozinho e o Nginx a entrega pra outro servidor.
    // Enquanto isso não termina, quem está usando merece ver o que está
    // acontecendo em vez de uma tela que simplesmente parou de responder.
    this.connection.onreconnecting(() => {
      this.connectionState.set('reconectando');
      this.myReplica.set(null);
    });

    this.connection.onreconnected(() => {
      // Não marca a réplica aqui: o servidor manda "ConnectedToReplica" de
      // novo em OnConnectedAsync, e é de lá que o nome vem.
      this.connectionState.set('conectado');
    });

    this.connection.onclose(() => {
      this.connectionState.set('desconectado');
      this.myReplica.set(null);
    });

    await this.connection.start();
    this.connectionState.set('conectado');
  }

  markPrivateRead(userName: string): void {
    this.unreadPrivate.update(set => {
      if (!set.has(userName)) return set;
      const next = new Set(set);
      next.delete(userName);
      return next;
    });
  }

  async sendMessage(message: string): Promise<void> {
    await this.connection?.invoke('SendMessage', message);
  }

  async sendPrivateMessage(toUserName: string, message: string): Promise<void> {
    await this.connection?.invoke('SendPrivateMessage', toUserName, message);

    // O servidor não ecoa a mensagem de volta pra quem manda (só entrega pro
    // destinatário); um eco não teria como carregar "pra quem eu mandei" de forma
    // inequívoca. Como já sabemos localmente o que mandamos e pra quem, adicionamos
    // na nossa própria conversa assim que o envio é confirmado.
    this.privateMessages.update(map => {
      const next = new Map(map);
      const existing = next.get(toUserName) ?? [];
      next.set(toUserName, [
        ...existing,
        { userName: this.currentUserName(), message, replica: '', timestamp: new Date().toISOString() }
      ]);
      return next;
    });
  }

  private addPulse(pulse: Omit<VisualizerPulse, 'id'>): void {
    const id = `${Date.now()}-${Math.random()}`;
    const fullPulse: VisualizerPulse = { ...pulse, id };
    this.visualizerPulses.update(pulses => [...pulses, fullPulse]);

    // Conectar/desconectar percorre 2 pernas (pessoa↔nginx↔servidor); mensagem
    // geral ou privada percorre até 6 (pessoa→nginx→servidor→redis→outro
    // servidor→nginx→outra pessoa). Ver VisualizerPanelComponent.legsFor.
    const totalLegs = pulse.kind === 'connect' || pulse.kind === 'disconnect' ? 2 : 6;
    setTimeout(() => {
      this.visualizerPulses.update(pulses => pulses.filter(p => p.id !== id));
    }, totalLegs * ChatService.HOP_MS);
  }
}
