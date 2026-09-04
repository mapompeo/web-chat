import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="chat-container" style="display: flex; gap: 2rem; max-width: 900px; margin: 2rem auto;">
      <aside style="width: 200px;">
        <h3>Sala: {{ roomName }}</h3>
        <h4>Online</h4>
        <ul>
          <li *ngFor="let user of chatService.onlineUsers()">{{ user }}</li>
        </ul>
      </aside>
      <main style="flex: 1;">
        <ul style="list-style: none; padding: 0;">
          <li *ngFor="let msg of chatService.messages()">
            <strong>{{ msg.userName }}</strong> ({{ msg.replica }}): {{ msg.message }}
          </li>
        </ul>
        @if (errorMessage) {
          <p style="color: #c0392b;">{{ errorMessage }}</p>
        }
        <div style="display: flex; gap: 0.5rem;">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" style="flex: 1;" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  roomName = '';
  userName = '';
  draft = '';
  errorMessage = '';

  constructor(private route: ActivatedRoute, public chatService: ChatService) {}

  async ngOnInit(): Promise<void> {
    this.roomName = this.route.snapshot.paramMap.get('room') ?? '';
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.chatService.isConnected) {
      try {
        await this.chatService.connect();
        await this.chatService.joinRoom(this.roomName, this.userName);
      } catch (err) {
        console.error('Falha ao conectar/entrar na sala', err);
        this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
      }
    }
  }

  async send(): Promise<void> {
    if (!this.draft.trim()) return;
    const messageToSend = this.draft;
    this.draft = '';
    try {
      await this.chatService.sendMessage(this.roomName, this.userName, messageToSend);
    } catch (err) {
      console.error('Falha ao enviar mensagem', err);
      this.draft = messageToSend;
      this.errorMessage = 'Não foi possível enviar a mensagem. Verifique a conexão.';
    }
  }
}
