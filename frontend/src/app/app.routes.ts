import { Routes } from '@angular/router';
import { JoinRoomComponent } from './pages/join-room/join-room.component';
import { ChatRoomComponent } from './pages/chat-room/chat-room.component';

export const routes: Routes = [
  { path: '', component: JoinRoomComponent },
  { path: 'room/:room', component: ChatRoomComponent }
];
