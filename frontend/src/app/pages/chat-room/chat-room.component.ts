import { Component, OnInit, ViewChild, ElementRef, effect, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ChatMessage, ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';
import { AvatarService } from '../../services/avatar.service';
import { VisualizerPanelComponent } from '../../components/visualizer-panel/visualizer-panel.component';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-chat-room',
  standalone: true,
  imports: [FormsModule, VisualizerPanelComponent, IconComponent],
  template: `
    <!-- with-visualizer marca o container inteiro, não só o <main>, porque no
         celular a sidebar também precisa saber que o visualizador está ocupando
         a metade de cima da tela, e CSS não tem como olhar para um irmão que
         vem depois dela no DOM. -->
    <div class="chat-container" [class.with-visualizer]="showVisualizer">
      @if (showSidebarMobile) {
        <div class="mobile-backdrop" (click)="showSidebarMobile = false"></div>
      }
      <aside class="sidebar" [class.mobile-open]="showSidebarMobile" [style.width.px]="sidebarWidth()">
        <h4>Conversas</h4>
        <ul class="conversation-list">
          <li>
            <button
              class="conversation-item"
              [class.active]="activeView === 'geral'"
              (click)="activeView = 'geral'; errorMessage = ''; showSidebarMobile = false"
            >
              <span class="conv-figure conv-figure-room">
                <app-icon name="users" />
              </span>
              <span class="conv-body">
                <span class="conv-name">Sala Geral</span>
                <span class="conv-sub">{{ chatService.onlineUsers().length }} online</span>
              </span>
            </button>
          </li>
          @for (user of otherOnlineUsers(); track user) {
            <li>
              <button
                class="conversation-item"
                [class.active]="activeView === user"
                (click)="selectConversation(user)"
              >
                <span class="conv-figure">
                  <img class="conv-avatar" [src]="avatar.getAvatar(user)" alt="" />
                  <span class="conv-online-dot" aria-hidden="true"></span>
                </span>
                <span class="conv-body">
                  <span class="conv-name">{{ user }}</span>
                  <span class="conv-sub">
                    <app-icon name="lock" />
                    conversa privada
                  </span>
                </span>
                @if (chatService.unreadPrivate().has(user)) {
                  <span class="unread-dot" aria-label="Mensagem não lida"></span>
                }
              </button>
            </li>
          }
        </ul>
      </aside>
      <div
        class="resize-handle"
        (mousedown)="startResize('sidebar', $event)"
        aria-hidden="true"
      ></div>
      <main class="conversation" [class.split-view]="showVisualizer">
        <div class="conversation-header">
          <button
            class="theme-toggle sidebar-toggle"
            type="button"
            (click)="showSidebarMobile = !showSidebarMobile"
            [attr.aria-label]="showSidebarMobile ? 'Esconder conversas' : 'Mostrar conversas'"
          >
            <app-icon name="menu" />
          </button>
          <div class="conversation-title">
            @if (activeView === 'geral') {
              <span class="conv-figure conv-figure-room">
                <app-icon name="users" />
              </span>
              <div class="conversation-title-text">
                <h3>Sala Geral</h3>
                <span class="conversation-subtitle">
                  {{ chatService.onlineUsers().length }} pessoa{{ chatService.onlineUsers().length === 1 ? '' : 's' }} online
                </span>
              </div>
            } @else {
              <span class="conv-figure">
                <img class="conv-avatar" [src]="avatar.getAvatar(activeView)" alt="" />
                <span class="conv-online-dot" aria-hidden="true"></span>
              </span>
              <div class="conversation-title-text">
                <h3>{{ activeView }}</h3>
                <span class="conversation-subtitle">
                  <app-icon name="lock" />
                  conversa privada
                </span>
              </div>
            }
          </div>
          <div class="header-actions">
            <!-- Sinais lidos direto no template, não copiados pra campo comum:
                 quem muda esses valores são retornos de chamada do SignalR, que
                 rodam fora do fluxo normal do Angular. Ver o comentário em
                 sidebarWidth mais abaixo. -->
            <span
              class="server-badge"
              [class.is-down]="chatService.connectionState() !== 'conectado'"
              [title]="connectionHint()"
            >
              <span class="server-dot" aria-hidden="true"></span>
              @if (chatService.myReplica(); as replica) {
                <app-icon name="server" />
                <span class="server-badge-text">{{ replica }}</span>
              } @else {
                <span class="server-badge-text">{{ chatService.connectionState() }}</span>
              }
            </span>
            <button
              class="theme-toggle"
              type="button"
              (click)="showVisualizer = !showVisualizer"
              [attr.aria-label]="showVisualizer ? 'Esconder visualizador de arquitetura' : 'Mostrar visualizador de arquitetura'"
            >
              <app-icon name="layout" />
            </button>
            <button
              class="theme-toggle"
              type="button"
              (click)="theme.toggle()"
              [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
            >
              <app-icon [name]="theme.mode() === 'dark' ? 'sun' : 'moon'" />
            </button>
          </div>
        </div>
        @if (errorMessage || chatService.joinError()) {
          <p class="error-text">
            <app-icon name="lock" />
            {{ errorMessage || chatService.joinError() }}
          </p>
        }
        <ul class="message-list" #messageListEl>
          @if (currentMessages().length === 0) {
            <li class="message-empty">
              <app-icon name="message" />
              <span>Nenhuma mensagem ainda. Diga alguma coisa!</span>
            </li>
          }
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
          <input
            class="text-input"
            [(ngModel)]="draft"
            [placeholder]="activeView === 'geral' ? 'Mensagem para a sala' : 'Mensagem para ' + activeView"
            (keyup.enter)="send()"
          />
          <button
            class="btn btn-primary btn-send"
            type="button"
            (click)="send()"
            [disabled]="!draft.trim()"
            aria-label="Enviar mensagem"
          >
            <app-icon name="send" />
            <span class="btn-label">Enviar</span>
          </button>
        </div>
      </main>
      @if (showVisualizer) {
        <div
          class="resize-handle"
          (mousedown)="startResize('visualizer', $event)"
          aria-hidden="true"
        ></div>
        <app-visualizer-panel [style.width.px]="visualizerWidth()" />
      }
    </div>
  `
})
export class ChatRoomComponent implements OnInit {
  userName = '';
  draft = '';
  activeView: 'geral' | string = 'geral';
  errorMessage = '';
  // No celular o visualizador começa escondido (é uma tela cheia por cima do
  // chat, ruim de abrir de cara); no desktop continua começando aberto,
  // já que é a peça que mais mostra o diferencial técnico do projeto.
  showVisualizer = window.innerWidth > 900;
  showSidebarMobile = false;

  // Sinais (não campos comuns) de propósito: o arrasto é feito com
  // document.addEventListener, fora do binding normal do Angular; usar sinal
  // e ler ele direto no template garante que a tela atualiza a cada movimento
  // do mouse, sem depender de detecção de mudança acontecer por acaso.
  readonly sidebarWidth = signal(240);
  readonly visualizerWidth = signal(500);
  private resizing: 'sidebar' | 'visualizer' | null = null;

  @ViewChild('messageListEl') messageListEl!: ElementRef<HTMLElement>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    public chatService: ChatService,
    public theme: ThemeService,
    public avatar: AvatarService
  ) {
    // Rola a lista de mensagens pro final sempre que uma nova mensagem chegar
    // (na sala atual ou numa conversa privada); sem isso, mensagens novas
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
    // tela, limpa o "não lida" de volta imediatamente; assim a bolinha só aparece
    // pra conversas que a pessoa não está olhando no momento.
    effect(() => {
      const unread = this.chatService.unreadPrivate();
      if (this.activeView !== 'geral' && unread.has(this.activeView)) {
        this.chatService.markPrivateRead(this.activeView);
      }
    });
  }

  // Arrastável só faz sentido em tela grande, onde os painéis são colunas
  // fixas de verdade; no celular eles viram painel flutuante/split-view (ver
  // styles.scss), e a alça de arrasto fica escondida lá (display:none), então
  // isso nunca dispara no mobile mesmo sem checar aqui.
  startResize(which: 'sidebar' | 'visualizer', event: MouseEvent): void {
    event.preventDefault();
    this.resizing = which;
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', this.onResizeMove);
    document.addEventListener('mouseup', this.onResizeEnd);
  }

  private readonly onResizeMove = (event: MouseEvent): void => {
    // O máximo de cada painel é 1/3 da largura da tela, recalculado a cada
    // movimento porque a janela pode ter sido redimensionada nesse meio tempo.
    const maxWidth = window.innerWidth / 3;
    if (this.resizing === 'sidebar') {
      const next = Math.min(Math.max(event.clientX, 180), maxWidth);
      this.sidebarWidth.set(next);
    } else if (this.resizing === 'visualizer') {
      const fromRightEdge = window.innerWidth - event.clientX;
      const next = Math.min(Math.max(fromRightEdge, 280), maxWidth);
      this.visualizerWidth.set(next);
    }
  };

  private readonly onResizeEnd = (): void => {
    this.resizing = null;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', this.onResizeMove);
    document.removeEventListener('mouseup', this.onResizeEnd);
  };

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
    this.showSidebarMobile = false;
  }

  // Texto do balão de ajuda do selo. Explica o que aquele nome de servidor
  // significa, que é o ponto do recurso: mostrar que a conexão foi parar numa
  // réplica específica e que derrubar essa réplica joga você em outra.
  connectionHint(): string {
    const replica = this.chatService.myReplica();
    switch (this.chatService.connectionState()) {
      case 'conectado':
        return replica
          ? `Sua conexão foi para o ${replica}. O Nginx escolheu ele por ter menos conexões abertas no momento; se ele cair, você reconecta em outro.`
          : 'Conectado.';
      case 'reconectando':
        return 'A conexão caiu e está sendo refeita. Ao voltar, o Nginx pode entregar você para outro servidor.';
      case 'desconectado':
        return 'Sem conexão com o servidor.';
      default:
        return 'Conectando ao servidor...';
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

  formatTime(timestamp: string): string {
    // O servidor manda o horário em UTC; formatamos aqui pra usar o fuso horário
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
      // o envio falhava; evita atropelar um rascunho mais recente (ver ciclo
      // anterior, revisão final, achado "sobrescrita de draft em corrida rara").
      if (this.draft === '') {
        this.draft = messageToSend;
      }
    }
  }
}
