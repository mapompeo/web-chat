import { defineConfig, devices } from '@playwright/test';

// Estes testes rodam contra o stack de verdade, subido com `docker compose up`:
// Nginx balanceando, três réplicas do backend e Redis. É de propósito. O que
// vale a pena verificar aqui não é se um componente Angular renderiza, e sim se
// duas pessoas em réplicas diferentes se enxergam, se o nome duplicado é
// recusado e se a conversa sobrevive a recarregar a página. Nada disso existe
// sem a infraestrutura em volta.
export default defineConfig({
  testDir: './e2e',
  // Uma pessoa entrando afeta a lista de quem está online para todas as outras,
  // então os testes não podem correr em paralelo sem interferir uns nos outros.
  workers: 1,
  fullyParallel: false,
  // Chat é assíncrono: a mensagem passa pelo Nginx, pelo backend e pelo Redis
  // antes de aparecer na outra ponta. As esperas do Playwright já são por
  // condição, mas o limite padrão é curto demais para um salto a mais de rede.
  expect: { timeout: 15_000 },
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
