import { Page, expect } from '@playwright/test';

/**
 * Nome único por execução. O chat recusa nome já em uso, e o Redis guarda
 * presença e histórico entre um teste e outro, então reaproveitar "Ana" faria
 * o segundo teste falhar por um motivo que não tem nada a ver com o que ele
 * queria verificar.
 */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Entra no chat pela tela inicial, do jeito que uma pessoa entraria. */
export async function signIn(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('input.text-input').fill(name);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chat\?user=/);
  // O selo só mostra o nome da réplica depois que o servidor confirma a
  // entrada, então esperar por ele garante que a conexão está de pé antes de
  // o teste seguir.
  await expect(serverBadge(page)).toContainText(/Servidor/);
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('input.text-input').fill(text);
  await page.locator('input.text-input').press('Enter');
}

export function bubbleWithText(page: Page, text: string) {
  return page.locator('.message-bubble').filter({ hasText: text });
}

export function serverBadge(page: Page) {
  return page.locator('.server-badge');
}

/** Em qual réplica esta aba caiu, segundo o selo do cabeçalho. */
export async function currentReplica(page: Page): Promise<string> {
  return (await serverBadge(page).innerText()).trim();
}
