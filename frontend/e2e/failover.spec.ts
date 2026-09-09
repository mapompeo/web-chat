import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { entrar, enviar, nomeUnico, balaoComTexto, replicaAtual, seloDoServidor } from './helpers';

/**
 * Este arquivo é o único que mexe na infraestrutura durante o teste, e por isso
 * fica separado dos demais: ele derruba uma réplica de propósito, pra provar
 * que a queda de um servidor não derruba quem estava nele.
 *
 * Só roda no stack local do docker compose. Contra a aplicação publicada não
 * faz sentido, porque lá as três réplicas vivem no mesmo container (ver o
 * cabeçalho do Dockerfile.render), então derrubar uma derruba tudo.
 */

const NOMES_DOS_CONTAINERS: Record<string, string> = {
  'Servidor A': 'backend1',
  'Servidor B': 'backend2',
  'Servidor C': 'backend3'
};

function docker(...args: string[]): void {
  execFileSync('docker', args, { cwd: '..', stdio: 'pipe' });
}

const rodandoNoStackLocal = (process.env.E2E_BASE_URL ?? 'http://localhost').includes('localhost');

test.describe('tolerância a falha', () => {
  test.skip(!rodandoNoStackLocal, 'derruba container, só faz sentido no docker compose local');
  // Precisa de tempo pra reconexão automática e pra varredura de presença órfã.
  test.setTimeout(120_000);

  test('derrubar a réplica migra a pessoa para outra, sem perder a conversa', async ({ page }) => {
    await entrar(page, nomeUnico('Karina'));

    const replicaAntes = await replicaAtual(page);
    const container = NOMES_DOS_CONTAINERS[replicaAntes];
    expect(container, `réplica inesperada: ${replicaAntes}`).toBeTruthy();

    const texto = `antes da queda ${Date.now()}`;
    await enviar(page, texto);
    await expect(balaoComTexto(page, texto)).toBeVisible();

    // kill e não stop: stop manda SIGTERM e dá ao processo a chance de encerrar
    // direito, o que esconde justamente o caso difícil. kill é morte súbita,
    // sem OnDisconnectedAsync, deixando presença órfã pra trás.
    docker('compose', 'kill', container);

    try {
      // O selo tem que acabar mostrando OUTRA réplica, sem erro nenhum na tela.
      await expect(seloDoServidor(page)).toContainText(/Servidor [ABC]/, { timeout: 90_000 });
      await expect
        .poll(async () => await replicaAtual(page), { timeout: 90_000 })
        .not.toBe(replicaAntes);

      await expect(page.locator('.error-text')).toHaveCount(0);
      // O histórico vem do Redis na reconexão, então a conversa continua ali.
      await expect(balaoComTexto(page, texto)).toBeVisible();

      // E a conversa segue funcionando na réplica nova.
      const depois = `depois da queda ${Date.now()}`;
      await enviar(page, depois);
      await expect(balaoComTexto(page, depois)).toBeVisible();
    } finally {
      docker('compose', 'start', container);
    }
  });
});
