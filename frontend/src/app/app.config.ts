import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

import { routes } from './app.routes';

// Não há biblioteca de componentes aqui de propósito. O projeto usava PrimeNG,
// mas só para dois elementos (o botão e o campo de texto), e a versão 22
// passou a exigir chave de licença comercial; sem ela a própria biblioteca
// injeta um aviso fixo de "Invalid PrimeUI License" na tela, que no celular
// cobria o botão de enviar. Botão e input nativos estilizados em styles.scss
// entregam o mesmo visual, sem licença, sem tema paralelo pra manter em
// sincronia com a paleta e com um bundle bem menor.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAnimationsAsync()
  ]
};
