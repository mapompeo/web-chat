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

    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente; a segunda
      // rejeita a conexão porque o connectionId só existe na réplica que negociou.
      // Pulando a negociação, a conexão vira uma única requisição atômica.
      .withUrl(`/chatHub?user=${encodeURIComponent(userName)}`, {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets
      })
      .withAutomaticReconnect()
      .build();

    this.connection.on('RoomJoined', (users: string[]) => {
      this.onlineUsers.set(users);
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

    await this.connection.start();
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
