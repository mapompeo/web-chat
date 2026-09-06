import { Component, Input } from '@angular/core';

type IconDef = {
  // Todo ícone é descrito só por <path>, mesmo os que visualmente têm círculos
  // ou retângulos: assim o template é um único @for e não precisa de um caso
  // especial por tipo de forma.
  paths: string[];
  // Logos de marca vêm como silhueta preenchida; os ícones de interface são
  // desenhados a traço. Os dois usam currentColor, então herdam a cor de quem
  // os contém (é assim que Redis e Nginx aparecem na cor de destaque do
  // projeto em vez das cores originais das marcas).
  mode?: 'stroke' | 'fill';
};

// Traçado dos ícones de interface, no estilo "line icon" de 24x24: mesma
// espessura e mesmos cantos arredondados em todos, pra eles parecerem de uma
// família só.
const ICONS: Record<string, IconDef> = {
  send: {
    paths: ['M22 2 11 13', 'M22 2 15 22 11 13 2 9z']
  },
  sun: {
    paths: [
      'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
      'M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41'
    ]
  },
  moon: {
    paths: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z']
  },
  menu: {
    paths: ['M4 6h16M4 12h16M4 18h16']
  },
  layout: {
    paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18']
  },
  users: {
    paths: [
      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2',
      'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      'M23 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75'
    ]
  },
  lock: {
    paths: [
      'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
      'M7 11V7a5 5 0 0 1 10 0v4'
    ]
  },
  message: {
    paths: [
      'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'
    ]
  },
  login: {
    paths: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3']
  },
  server: {
    paths: [
      'M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
      'M4 13h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
      'M7 7.5h.01',
      'M7 16.5h.01'
    ]
  },

  // Logos de marca (Simple Icons, CC0). O do Redis é o clássico de camadas
  // empilhadas; é o desenho que as pessoas reconhecem como "banco de dados
  // em memória", diferente do "R" do rebrand recente, que não comunica nada
  // sozinho num diagrama de arquitetura.
  redis: {
    mode: 'fill',
    paths: [
      'M10.5 2.661l.54.997-1.797.644 2.409.218.748 1.246.467-1.121 2.077-.208-1.61-.613.426-1.017-1.578.519zm6.905 2.077L13.76 6.182l3.292 1.298.353-.146 3.293-1.298zm-10.51.312a2.97 1.153 0 0 0-2.97 1.152 2.97 1.153 0 0 0 2.97 1.153 2.97 1.153 0 0 0 2.97-1.153 2.97 1.153 0 0 0-2.97-1.152zM24 6.805s-8.983 4.278-10.395 4.953c-1.226.561-1.901.561-3.261.094C8.318 11.022 0 7.241 0 7.241v1.038c0 .24.332.499.966.8 1.277.613 8.34 3.677 9.45 4.206 1.112.53 1.9.54 3.313-.197 1.412-.738 8.049-3.905 9.326-4.57.654-.342.945-.602.945-.84zm-10.042.602L8.39 8.26l3.884 1.61zM24 10.637s-8.983 4.279-10.395 4.954c-1.226.56-1.901.56-3.261.093C8.318 14.854 0 11.074 0 11.074v1.038c0 .238.332.498.966.8 1.277.612 8.34 3.676 9.45 4.205 1.112.53 1.9.54 3.313-.197 1.412-.737 8.049-3.905 9.326-4.57.654-.332.945-.602.945-.84zm0 3.842l-10.395 4.954c-1.226.56-1.901.56-3.261.094C8.318 18.696 0 14.916 0 14.916v1.038c0 .239.332.499.966.8 1.277.613 8.34 3.676 9.45 4.206 1.112.53 1.9.54 3.313-.198 1.412-.737 8.049-3.904 9.326-4.569.654-.343.945-.613.945-.841z'
    ]
  },
  nginx: {
    mode: 'fill',
    paths: [
      'M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm6 16.59c0 .705-.646 1.29-1.529 1.29-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18H18z'
    ]
  }
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `
    <svg
      class="app-icon"
      viewBox="0 0 24 24"
      [attr.fill]="def.mode === 'fill' ? 'currentColor' : 'none'"
      [attr.stroke]="def.mode === 'fill' ? null : 'currentColor'"
      [attr.stroke-width]="def.mode === 'fill' ? null : 2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @for (d of def.paths; track d) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .app-icon {
        /* 1em faz o ícone acompanhar o tamanho da fonte de quem o contém, então
           o mesmo ícone serve num botão grande e num rótulo pequeno sem precisar
           de uma classe de tamanho pra cada lugar. */
        width: 1em;
        height: 1em;
      }
    `
  ]
})
export class IconComponent {
  @Input({ required: true }) name!: string;

  get def(): IconDef {
    return ICONS[this.name] ?? { paths: [] };
  }
}
