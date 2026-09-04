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

  async connect(): Promise<void> {
    this.connection = new signalR.HubConnectionBuilder()
      .withUrl('/chatHub')
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
