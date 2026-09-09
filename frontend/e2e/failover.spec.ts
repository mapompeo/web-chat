import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { signIn, sendMessage, uniqueName, bubbleWithText, currentReplica, serverBadge } from './helpers';

/**
 * Este arquivo é o único que mexe na infraestrutura durante o teste, e por isso
 * fica separado dos demais: ele derruba uma réplica de propósito, pra provar
 * que a queda de um servidor não derruba quem estava nele.
 *
 * Só roda no stack local do docker compose. Contra a aplicação publicada não
 * faz sentido, porque lá as três réplicas vivem no mesmo container (ver o
 * cabeçalho do Dockerfile.render), então derrubar uma derruba tudo.
 */

const CONTAINER_BY_REPLICA: Record<string, string> = {
  'Servidor A': 'backend1',
  'Servidor B': 'backend2',
  'Servidor C': 'backend3'
};

function docker(...args: string[]): void {
  execFileSync('docker', args, { cwd: '..', stdio: 'pipe' });
}

const runningAgainstLocalStack = (process.env.E2E_BASE_URL ?? 'http://localhost').includes('localhost');

test.describe('tolerância a falha', () => {
  test.skip(!runningAgainstLocalStack, 'derruba container, só faz sentido no docker compose local');
  // Precisa de tempo pra reconexão automática e pra varredura de presença órfã.
  test.setTimeout(120_000);

  test('derrubar a réplica migra a pessoa para outra, sem perder a conversa', async ({ page }) => {
    await signIn(page, uniqueName('Karina'));

    const replicaBefore = await currentReplica(page);
    const container = CONTAINER_BY_REPLICA[replicaBefore];
    expect(container, `réplica inesperada: ${replicaBefore}`).toBeTruthy();

    const text = `antes da queda ${Date.now()}`;
    await sendMessage(page, text);
    await expect(bubbleWithText(page, text)).toBeVisible();

    // kill e não stop: stop manda SIGTERM e dá ao processo a chance de encerrar
    // direito, o que esconde justamente o caso difícil. kill é morte súbita,
    // sem OnDisconnectedAsync, deixando presença órfã pra trás.
    docker('compose', 'kill', container);

    try {
      // O selo tem que acabar mostrando OUTRA réplica, sem erro nenhum na tela.
      await expect(serverBadge(page)).toContainText(/Servidor [ABC]/, { timeout: 90_000 });
      await expect
        .poll(async () => await currentReplica(page), { timeout: 90_000 })
        .not.toBe(replicaBefore);

      await expect(page.locator('.error-text')).toHaveCount(0);
      // O histórico vem do Redis na reconexão, então a conversa continua ali.
      await expect(bubbleWithText(page, text)).toBeVisible();

      // E a conversa segue funcionando na réplica nova.
      const after = `depois da queda ${Date.now()}`;
      await sendMessage(page, after);
      await expect(bubbleWithText(page, after)).toBeVisible();
    } finally {
      docker('compose', 'start', container);
    }
  });
});
