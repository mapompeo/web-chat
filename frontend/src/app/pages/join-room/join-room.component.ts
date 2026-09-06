import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';
import { AvatarService } from '../../services/avatar.service';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-join-room',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="join-page">
      <button
        class="theme-toggle"
        type="button"
        (click)="theme.toggle()"
        [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
      >
        <app-icon [name]="theme.mode() === 'dark' ? 'sun' : 'moon'" />
      </button>
      <div class="join-container">
        <div class="join-brand">
          <app-icon name="message" />
        </div>
        <h1>Entrar no chat</h1>
        <p class="join-hint">Escolha um nome: ele precisa ser único entre quem está online.</p>

        <!-- Prévia ao vivo do avatar: como o desenho é derivado do nome, ele
             muda a cada letra digitada, deixando claro que cada pessoa ganha
             um rosto próprio antes mesmo de entrar na sala. -->
        <div class="join-preview">
          @if (userName.trim()) {
            <img class="join-avatar" [src]="avatar.getAvatar(userName.trim())" alt="" />
            <span class="join-preview-name">{{ userName.trim() }}</span>
          } @else {
            <span class="join-avatar join-avatar-empty">
              <app-icon name="users" />
            </span>
            <span class="join-preview-name join-preview-placeholder">seu avatar aparece aqui</span>
          }
        </div>

        <input
          class="text-input"
          [(ngModel)]="userName"
          placeholder="Seu nome"
          (keyup.enter)="join()"
        />
        <button class="btn btn-primary" type="button" (click)="join()" [disabled]="!userName.trim()">
          <app-icon name="login" />
          <span class="btn-label">Entrar</span>
        </button>
        @if (errorMessage) {
          <p class="error-text">
            <app-icon name="lock" />
            {{ errorMessage }}
          </p>
        }
      </div>
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  errorMessage = '';

  constructor(
    private chatService: ChatService,
    private router: Router,
    public theme: ThemeService,
    public avatar: AvatarService
  ) {}

  async join(): Promise<void> {
    if (!this.userName.trim()) return;

    this.errorMessage = '';
    const trimmedName = this.userName.trim();
    try {
      await this.chatService.connect(trimmedName);
      this.router.navigate(['/chat'], { queryParams: { user: trimmedName } });
    } catch {
      this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
    }
  }
}
