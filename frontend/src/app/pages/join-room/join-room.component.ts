import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatService } from '../../services/chat.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-join-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="join-page">
      <button
        class="theme-toggle"
        type="button"
        (click)="theme.toggle()"
        [attr.aria-label]="theme.mode() === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
      >
        <i class="pi" [class.pi-sun]="theme.mode() === 'dark'" [class.pi-moon]="theme.mode() === 'light'"></i>
      </button>
      <div class="join-container">
        <h1>Entrar no chat</h1>
        <input pInputText [(ngModel)]="userName" placeholder="Seu nome" (keyup.enter)="join()" />
        <p-button label="Entrar" (onClick)="join()" [disabled]="!userName.trim()" />
        @if (errorMessage) {
          <p class="error-text">{{ errorMessage }}</p>
        }
      </div>
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  errorMessage = '';

  constructor(private chatService: ChatService, private router: Router, public theme: ThemeService) {}

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
