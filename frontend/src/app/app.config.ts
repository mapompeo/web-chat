import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';

import { routes } from './app.routes';

// Substitui o azul/verde padrão do preset Aura pela cor de destaque (--accent)
// usada no resto da aplicação, para que botões e inputs do PrimeNG fiquem
// visualmente coerentes com a paleta custom definida em styles.scss.
const AppTheme = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#f5f8fd',
      100: '#d0dcf8',
      200: '#abc1f2',
      300: '#85a6ec',
      400: '#608ae6',
      500: '#3b6fe0',
      600: '#325ebe',
      700: '#294e9d',
      800: '#203d7b',
      900: '#182c5a',
      950: '#0f1c38',
      // O default do Aura usa `light-dark(#ffffff, {surface.900})` aqui,
      // assumindo que o tom 400 do primary em dark mode é um pastel claro
      // (por isso escolhe texto ESCURO em cima dele). Nosso 400 (#608ae6) é
      // um azul de saturação média, não um pastel — com o default, o botão
      // ficava com texto quase preto (`{surface.900}` = `#18181b`) sobre
      // fundo azul médio, ilegível. Fixamos branco nos dois temas, que tem
      // contraste adequado tanto contra `#3b6fe0` (light) quanto `#608ae6`
      // (dark).
      contrastColor: '#ffffff'
    }
  }
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: AppTheme,
        options: {
          // Mesmo atributo `data-theme` que o ThemeService aplica em <html>,
          // assim os componentes do PrimeNG trocam de aparência junto com o
          // resto da paleta custom.
          darkModeSelector: '[data-theme="dark"]'
        }
      }
    })
  ]
};
