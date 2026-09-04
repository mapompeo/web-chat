import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatMessage, ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="chat-container">
      <aside class="sidebar">
        <h4>Conversas</h4>
        <ul class="conversation-list">
          <li>
            <button
              class="conversation-item"
              [class.active]="activeView === 'geral'"
              (click)="activeView = 'geral'; errorMessage = ''"
            >Sala Geral</button>
          </li>
          @for (user of otherOnlineUsers(); track user) {
            <li>
              <button
                class="conversation-item"
                [class.active]="activeView === user"
                (click)="activeView = user; errorMessage = ''"
              >{{ user }}</button>
            </li>
          }
        </ul>
      </aside>
      <main class="conversation">
        <div class="conversation-header">
          <h3>{{ activeView === 'geral' ? 'Sala Geral' : 'Privado com ' + activeView }}</h3>
          <button
            class="theme-toggle"
            type="button"
            (click)="theme.toggle()"
            [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
          >
            <i class="pi" [class.pi-sun]="theme.mode() === 'dark'" [class.pi-moon]="theme.mode() === 'light'"></i>
          </button>
        </div>
        @if (errorMessage) {
          <p class="error-text">{{ errorMessage }}</p>
        }
        <ul class="message-list">
          @for (msg of currentMessages(); track $index) {
            <li class="message" [class.mine]="msg.userName === chatService.currentUserName()">
              <strong>{{ msg.userName }}</strong>
              @if (msg.replica) { <span class="replica-tag">({{ msg.replica }})</span> }
              : {{ msg.message }}
            </li>
          }
        </ul>
        <div class="input-row">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  userName = '';
  draft = '';
  activeView: 'geral' | string = 'geral';
  errorMessage = '';

  constructor(private route: ActivatedRoute, public chatService: ChatService, public theme: ThemeService) {}

  async ngOnInit(): Promise<void> {
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.chatService.isConnected && this.userName) {
      try {
        await this.chatService.connect(this.userName);
      } catch {
        this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
      }
    }
  }

  otherOnlineUsers(): string[] {
    return this.chatService.onlineUsers().filter(u => u !== this.userName);
  }

  currentMessages(): ChatMessage[] {
    if (this.activeView === 'geral') {
      return this.chatService.geralMessages();
    }
    return this.chatService.privateMessages().get(this.activeView) ?? [];
  }

  async send(): Promise<void> {
    if (!this.draft.trim()) return;
    const messageToSend = this.draft;
    this.draft = '';
    this.errorMessage = '';

    try {
      if (this.activeView === 'geral') {
        await this.chatService.sendMessage(messageToSend);
      } else {
        await this.chatService.sendPrivateMessage(this.activeView, messageToSend);
      }
    } catch {
      this.errorMessage = 'Não foi possível enviar a mensagem.';
      // só restaura o rascunho se a pessoa não tiver digitado algo novo enquanto
      // o envio falhava — evita atropelar um rascunho mais recente (ver ciclo
      // anterior, revisão final, achado "sobrescrita de draft em corrida rara").
      if (this.draft === '') {
        this.draft = messageToSend;
      }
    }
  }
}
