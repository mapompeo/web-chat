import { Component, OnInit, ViewChild, ElementRef, effect } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatMessage, ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';
import { AvatarService } from '../../services/avatar.service';
import { VisualizerPanelComponent } from '../../components/visualizer-panel/visualizer-panel.component';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule, VisualizerPanelComponent],
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
                (click)="selectConversation(user)"
              >
                {{ user }}
                @if (chatService.unreadPrivate().has(user)) {
                  <span class="unread-dot" aria-label="Mensagem não lida"></span>
                }
              </button>
            </li>
          }
        </ul>
      </aside>
      <main class="conversation">
        <div class="conversation-header">
          <h3>{{ activeView === 'geral' ? 'Sala Geral' : 'Privado com ' + activeView }}</h3>
          <div class="header-actions">
            <button
              class="theme-toggle"
              type="button"
              (click)="showVisualizer = !showVisualizer"
              [attr.aria-label]="showVisualizer ? 'Esconder visualizador de arquitetura' : 'Mostrar visualizador de arquitetura'"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1rem;height:1rem;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>
            </button>
            <button
              class="theme-toggle"
              type="button"
              (click)="theme.toggle()"
              [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
            >
              <i class="pi" [class.pi-sun]="theme.mode() === 'dark'" [class.pi-moon]="theme.mode() === 'light'"></i>
            </button>
          </div>
        </div>
        @if (errorMessage || chatService.joinError()) {
          <p class="error-text">{{ errorMessage || chatService.joinError() }}</p>
        }
        <ul class="message-list" #messageListEl>
          @for (msg of currentMessages(); track $index) {
            <li class="message-row" [class.mine]="msg.userName === chatService.currentUserName()">
              <img class="avatar" [src]="avatar.getAvatar(msg.userName)" alt="" />
              <div class="message-col">
                <div class="message-info">
                  <strong>{{ msg.userName }}</strong>
                  <span class="dot">·</span>
                  <span class="timestamp">{{ formatTime(msg.timestamp) }}</span>
                </div>
                <p class="message-bubble">{{ msg.message }}</p>
              </div>
            </li>
          }
        </ul>
        <div class="input-row">
          <input pInputText [(ngModel)]="draft" placeholder="Mensagem" (keyup.enter)="send()" />
          <p-button label="Enviar" (onClick)="send()" />
        </div>
      </main>
      @if (showVisualizer) {
        <app-visualizer-panel />
      }
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  userName = '';
  draft = '';
  activeView: 'geral' | string = 'geral';
  errorMessage = '';
  showVisualizer = true;

  @ViewChild('messageListEl') messageListEl!: ElementRef<HTMLElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public chatService: ChatService,
    public theme: ThemeService,
    public avatar: AvatarService
  ) {
    // Rola a lista de mensagens pro final sempre que uma nova mensagem chegar
    // (na sala atual ou numa conversa privada) — sem isso, mensagens novas
    // ficam escondidas abaixo da área visível assim que a lista cresce demais.
    // O setTimeout(0) empurra a rolagem pro próximo tick, depois que o Angular
    // já atualizou o DOM com o novo <li>.
    effect(() => {
      this.currentMessages();
      setTimeout(() => {
        const el = this.messageListEl?.nativeElement;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }, 0);
    });

    // Se a conversa que acabou de receber mensagem nova já é a que está aberta na
    // tela, limpa o "não lida" de volta imediatamente — assim a bolinha só aparece
    // pra conversas que a pessoa não está olhando no momento.
    effect(() => {
      const unread = this.chatService.unreadPrivate();
      if (this.activeView !== 'geral' && unread.has(this.activeView)) {
        this.chatService.markPrivateRead(this.activeView);
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';

    if (!this.userName) {
      this.router.navigate(['/']);
      return;
    }

    if (!this.chatService.isConnected) {
      try {
        await this.chatService.connect(this.userName);
      } catch {
        this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
      }
    }
  }

  selectConversation(user: string): void {
    this.activeView = user;
    this.errorMessage = '';
    this.chatService.markPrivateRead(user);
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

  formatTime(timestamp: string): string {
    // O servidor manda o horário em UTC — formatamos aqui pra usar o fuso horário
    // local de quem está vendo, já que o container pode rodar em outro fuso.
    return new Date(timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
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
