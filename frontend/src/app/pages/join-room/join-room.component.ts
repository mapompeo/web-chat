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
    <div class="join-container" style="max-width: 320px; margin: 4rem auto; display: flex; flex-direction: column; gap: 1rem;">
      <h1>Entrar no chat</h1>
      <input pInputText [(ngModel)]="userName" placeholder="Seu nome" />
      <input pInputText [(ngModel)]="roomName" placeholder="Nome da sala" />
      <p-button label="Entrar" (onClick)="join()" [disabled]="!userName || !roomName" />
    </div>
  `
})
export class JoinRoomComponent {
  userName = '';
  roomName = '';

  constructor(private chatService: ChatService, private router: Router) {}

  async join(): Promise<void> {
    await this.chatService.connect();
    await this.chatService.joinRoom(this.roomName, this.userName);
    this.router.navigate(['/room', this.roomName], { queryParams: { user: this.userName } });
  }
}
