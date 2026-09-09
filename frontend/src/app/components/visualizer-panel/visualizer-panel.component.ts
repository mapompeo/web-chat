import { Component } from '@angular/core';
import { ChatService, VisualizerPulse } from '../../services/chat.service';
import { AvatarService } from '../../services/avatar.service';
import { IconComponent } from '../icon/icon.component';

type PulseDirection = 'up' | 'down';
type PulseLeg = { pulse: VisualizerPulse; direction: PulseDirection; stage: number; row: 1 | 2 | 3 };

// Cada "perna" da jornada dura o mesmo tempo, e elas acontecem em sequência
// (perna 1 termina, perna 2 começa), não todas de uma vez. Precisa bater com
// a duração da animação declarada em @keyframes viz-flow-down/viz-flow-up no
// styles.scss (0.5s) e com o tempo de vida de cada pulso no ChatService.
const HOP_MS = 500;

@Component({
  selector: 'app-visualizer-panel',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="visualizer-panel">
      <h4>Arquitetura ao vivo</h4>

      <div class="viz-node">
        <div class="viz-node-head">
          <app-icon class="viz-icon" name="redis" />
          Redis
          <span class="viz-count">backplane</span>
        </div>
      </div>

      <div class="viz-connectors">
        @for (replica of replicaNames; track replica) {
          <div class="viz-lane">
            @for (leg of legsInRow(1, replica); track leg.pulse.id + leg.direction) {
              <div
                class="viz-pulse"
                [style.animation-delay.ms]="leg.stage * hopMs"
                [class.reverse]="leg.direction === 'up'"
                [class.gray]="leg.pulse.kind === 'privada'"
              ></div>
            }
          </div>
        }
      </div>

      <div class="viz-servers">
        @for (replica of replicaNames; track replica) {
          <div class="viz-node">
            <div class="viz-node-head">
              <app-icon class="viz-icon" name="server" />
              {{ replica }}
            </div>
          </div>
        }
      </div>

      <div class="viz-connectors">
        @for (replica of replicaNames; track replica) {
          <div class="viz-lane">
            @for (leg of legsInRow(2, replica); track leg.pulse.id + leg.direction) {
              <div
                class="viz-pulse"
                [style.animation-delay.ms]="leg.stage * hopMs"
                [class.reverse]="leg.direction === 'up'"
                [class.gray]="leg.pulse.kind === 'privada'"
                [class.connect]="leg.pulse.kind === 'connect'"
                [class.disconnect]="leg.pulse.kind === 'disconnect'"
              ></div>
            }
          </div>
        }
      </div>

      <div class="viz-node">
        <div class="viz-node-head">
          <app-icon class="viz-icon" name="nginx" />
          Nginx
          <span class="viz-count">load balancer</span>
        </div>
      </div>

      <div class="viz-connectors">
        @for (replica of replicaNames; track replica) {
          <div class="viz-lane">
            @for (leg of legsInRow(3, replica); track leg.pulse.id + leg.direction) {
              <div
                class="viz-pulse"
                [style.animation-delay.ms]="leg.stage * hopMs"
                [class.reverse]="leg.direction === 'up'"
                [class.gray]="leg.pulse.kind === 'privada'"
                [class.connect]="leg.pulse.kind === 'connect'"
                [class.disconnect]="leg.pulse.kind === 'disconnect'"
              ></div>
            }
          </div>
        }
      </div>

      <div class="viz-people-row">
        @for (replica of replicaNames; track replica) {
          <div class="viz-people-group">
            <span class="viz-group-label">{{ replica }}</span>
            @if (usersIn(replica).length > 0) {
              <div class="viz-people">
                @for (person of usersIn(replica); track person) {
                  <div class="viz-person" [class.viz-dimmed]="isDimmed(person, replica)">
                    <img class="viz-avatar" [src]="avatar.getAvatar(person)" alt="" />
                    <span class="viz-name">{{ person }}</span>
                  </div>
                }
              </div>
            } @else {
              <div class="viz-empty-hint">ninguém conectado</div>
            }
          </div>
        }
      </div>
    </div>
  `
})
export class VisualizerPanelComponent {
  // Mesma lista fixa que o backend usa em ChatHub.AllReplicaNames. Ver
  // docs/design/2026-09-05-visualizador-arquitetura-design.md
  // pela explicação de por que isso é hardcoded nos dois lados.
  readonly replicaNames = ['Servidor A', 'Servidor B', 'Servidor C'];
  readonly hopMs = HOP_MS;

  constructor(public chatService: ChatService, public avatar: AvatarService) {}

  usersIn(replica: string): string[] {
    return this.chatService.replicaUsers().get(replica) ?? [];
  }

  // Cada perna da jornada de um pulso nesta réplica: em qual faixa aparece
  // (1 = Redis/Servidor, 2 = Servidor/Nginx, 3 = Nginx/Pessoas), pra que lado
  // anda e em que posição da sequência entra, o que define o atraso da animação.
  //
  // Conectar e desconectar só usam as faixas 2 e 3, porque presença não passa
  // pelo backplane. Mensagem usa as três: sobe da origem até o Redis (0-2) e
  // desce dele até cada réplica ativa (3-5).
  //
  // A réplica de origem NÃO é excluída da entrega, e isso é intencional: não
  // existe atalho de entrega local. Conferido no código-fonte do
  // RedisHubLifetimeManager, onde SendGroupAsync apenas publica, e todo
  // servidor, inclusive o que enviou, só entrega aos próprios clientes ao
  // receber a publicação de volta.
  private legsFor(pulse: VisualizerPulse, replica: string): PulseLeg[] {
    if (pulse.kind === 'connect' || pulse.kind === 'disconnect') {
      if (pulse.replica !== replica) return [];
      return pulse.kind === 'connect'
        ? [
            { pulse, direction: 'up', stage: 0, row: 3 },  // pessoa -> nginx
            { pulse, direction: 'up', stage: 1, row: 2 }   // nginx -> servidor
          ]
        : [
            { pulse, direction: 'down', stage: 0, row: 2 }, // servidor -> nginx
            { pulse, direction: 'down', stage: 1, row: 3 }  // nginx -> pessoa
          ];
    }

    const legs: PulseLeg[] = [];
    if (pulse.fromReplica === replica) {
      legs.push({ pulse, direction: 'up', stage: 0, row: 3 }); // pessoa -> nginx
      legs.push({ pulse, direction: 'up', stage: 1, row: 2 }); // nginx -> servidor
      legs.push({ pulse, direction: 'up', stage: 2, row: 1 }); // servidor -> redis
    }
    if (pulse.toReplicas?.includes(replica)) {
      legs.push({ pulse, direction: 'down', stage: 3, row: 1 }); // redis -> servidor
      legs.push({ pulse, direction: 'down', stage: 4, row: 2 }); // servidor -> nginx
      legs.push({ pulse, direction: 'down', stage: 5, row: 3 }); // nginx -> pessoa
    }
    return legs;
  }

  // Só vale pra mensagem geral: a privada é anônima de propósito, então não há
  // quem destacar. Quem enviou nunca esmaece; os demais voltam ao normal assim
  // que o pulso termina.
  isDimmed(person: string, replica: string): boolean {
    for (const pulse of this.chatService.visualizerPulses()) {
      if (pulse.kind !== 'geral') continue;
      if (person === pulse.userName) continue;
      if (replica === pulse.fromReplica || pulse.toReplicas?.includes(replica)) {
        return true;
      }
    }
    return false;
  }

  legsInRow(row: 1 | 2 | 3, replica: string): PulseLeg[] {
    const results: PulseLeg[] = [];
    for (const p of this.chatService.visualizerPulses()) {
      for (const leg of this.legsFor(p, replica)) {
        if (leg.row === row) {
          results.push(leg);
        }
      }
    }
    return results;
  }
}
