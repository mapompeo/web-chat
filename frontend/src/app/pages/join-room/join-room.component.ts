import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ChatService } from '../../services/chat.service';

@Component({
  selector: 'app-join-room',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
  template: `
    <div class="join-container">
      <h1>Entrar no chat</h1>
      <input pInputText [(ngModel)]="userName" placeholder="Seu nome" (keyup.enter)="join()" />
      <p-button label="Entrar" (onClick)="join()" [disabled]="!userName.trim()" />
      @if (errorMessage) {
        <p class="error-text">{{ errorMessage }}</p>
      }
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  errorMessage = '';

  constructor(private chatService: ChatService, private router: Router) {}

  async join(): Promise<void> {
    if (!this.userName.trim()) return;

    this.errorMessage = '';
    try {
      await this.chatService.connect(this.userName);
      this.router.navigate(['/chat'], { queryParams: { user: this.userName } });
    } catch {
      this.errorMessage = 'Não foi possível conectar ao chat. Verifique se o backend está rodando.';
    }
  }
}
