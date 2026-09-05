import { Injectable, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';

export interface ChatMessage {
  userName: string;
  message: string;
  replica: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private connection?: signalR.HubConnection;

  readonly currentUserName = signal<string>('');
  readonly onlineUsers = signal<string[]>([]);
  readonly geralMessages = signal<ChatMessage[]>([]);
  readonly privateMessages = signal<Map<string, ChatMessage[]>>(new Map());
  readonly unreadPrivate = signal<Set<string>>(new Set());

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

    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente — a segunda
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
      // Marca como não lida sempre — quem estiver com a conversa aberta na hora
      // limpa isso de volta imediatamente (ver efeito em ChatRoomComponent), então
      // na prática só fica marcado quem realmente não está olhando aquela conversa.
      this.unreadPrivate.update(set => new Set(set).add(fromUser));
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
    // destinatário) — um eco não teria como carregar "pra quem eu mandei" de forma
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
}
