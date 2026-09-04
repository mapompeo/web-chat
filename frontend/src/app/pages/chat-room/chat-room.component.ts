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

  constructor(private route: ActivatedRoute, public chatService: ChatService) {}

  ngOnInit(): void {
    this.roomName = this.route.snapshot.paramMap.get('room') ?? '';
    this.userName = this.route.snapshot.queryParamMap.get('user') ?? '';
  }

  send(): void {
    if (!this.draft.trim()) return;
    this.chatService.sendMessage(this.roomName, this.userName, this.draft);
    this.draft = '';
  }
}
