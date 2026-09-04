import { Injectable, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';

export interface ChatMessage {
  userName: string;
  message: string;
  replica: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private connection?: signalR.HubConnection;

  readonly onlineUsers = signal<string[]>([]);
  readonly messages = signal<ChatMessage[]>([]);

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  async connect(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
    }

    this.messages.set([]);
    this.onlineUsers.set([]);

    this.connection = new signalR.HubConnectionBuilder()
      // skipNegotiation + WebSockets-only: sem isso, o cliente faz um POST
      // /negotiate separado antes do upgrade de WebSocket, e sem sticky sessions
      // o Nginx pode mandar cada requisição pra uma réplica diferente — a segunda
      // rejeita a conexão porque o connectionId só existe na réplica que negociou.
      // Pulando a negociação, a conexão vira uma única requisição atômica.
      .withUrl('/chatHub', {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets
      })
      .withAutomaticReconnect()
      .build();

    this.connection.on('RoomJoined', (users: string[]) => {
      this.onlineUsers.set(users);
    });

    this.connection.on('UserJoined', (userName: string) => {
      this.onlineUsers.update(users => [...users, userName]);
    });

    this.connection.on('UserLeft', (userName: string) => {
      this.onlineUsers.update(users => users.filter(u => u !== userName));
    });

    this.connection.on('ReceiveMessage', (userName: string, message: string, replica: string) => {
      this.messages.update(msgs => [...msgs, { userName, message, replica }]);
    });

    await this.connection.start();
  }

  async joinRoom(roomName: string, userName: string): Promise<void> {
    await this.connection?.invoke('JoinRoom', roomName, userName);
  }

  async sendMessage(roomName: string, userName: string, message: string): Promise<void> {
    await this.connection?.invoke('SendMessage', roomName, userName, message);
  }
}
