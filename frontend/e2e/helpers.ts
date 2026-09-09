import { Page, expect } from '@playwright/test';

/**
 * Nome único por execução. O chat recusa nome já em uso, e o Redis guarda
 * presença e histórico entre um teste e outro, então reaproveitar "Ana" faria
 * o segundo teste falhar por um motivo que não tem nada a ver com o que ele
 * queria verificar.
 */
export function nomeUnico(prefixo: string): string {
  return `${prefixo}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Entra no chat pela tela inicial, do jeito que uma pessoa entraria. */
export async function entrar(page: Page, nome: string): Promise<void> {
  await page.goto('/');
  await page.locator('input.text-input').fill(nome);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/chat\?user=/);
  // O selo só mostra o nome da réplica depois que o servidor confirma a
  // entrada, então esperar por ele garante que a conexão está de pé antes de
  // o teste seguir.
  await expect(seloDoServidor(page)).toContainText(/Servidor/);
}

export async function enviar(page: Page, texto: string): Promise<void> {
  await page.locator('input.text-input').fill(texto);
  await page.locator('input.text-input').press('Enter');
}

export function balaoComTexto(page: Page, texto: string) {
  return page.locator('.message-bubble').filter({ hasText: texto });
}

export function seloDoServidor(page: Page) {
  return page.locator('.server-badge');
}

/** Em qual réplica esta aba caiu, segundo o selo do cabeçalho. */
export async function replicaAtual(page: Page): Promise<string> {
  return (await seloDoServidor(page).innerText()).trim();
}
