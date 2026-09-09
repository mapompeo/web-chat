import { test, expect } from '@playwright/test';
import {
  balaoComTexto,
  entrar,
  enviar,
  nomeUnico,
  replicaAtual,
  seloDoServidor
} from './helpers';

test.describe('entrada no chat', () => {
  test('entra pela tela inicial e cai numa das réplicas', async ({ page }) => {
    await entrar(page, nomeUnico('Ana'));

    // Qual das três atendeu não importa (quem decide é o load balancer), mas
    // tem que ser uma delas, e o indicador tem que estar verde.
    await expect(seloDoServidor(page)).toContainText(/Servidor [ABC]/);
    await expect(seloDoServidor(page)).not.toHaveClass(/is-down/);
  });

  test('recusa um nome que já está em uso', async ({ browser }) => {
    const nome = nomeUnico('Duplicada');

    const primeira = await browser.newContext();
    const paginaOriginal = await primeira.newPage();
    await entrar(paginaOriginal, nome);

    // Contexto separado, e não outra aba: o identificador de cliente vive no
    // sessionStorage, e a mesma aba reconectando é justamente o caso que DEVE
    // ser aceito. Aqui queremos outra pessoa querendo o mesmo nome.
    const segunda = await browser.newContext();
    const paginaIntrusa = await segunda.newPage();
    await paginaIntrusa.goto(`/chat?user=${encodeURIComponent(nome)}`);

    await expect(paginaIntrusa.locator('.error-text')).toContainText('já está em uso');

    await primeira.close();
    await segunda.close();
  });
});

test.describe('conversa', () => {
  test('mensagem da Sala Geral chega para a outra pessoa', async ({ browser }) => {
    const contextoA = await browser.newContext();
    const contextoB = await browser.newContext();
    const paginaA = await contextoA.newPage();
    const paginaB = await contextoB.newPage();

    const nomeA = nomeUnico('Bia');
    await entrar(paginaA, nomeA);
    await entrar(paginaB, nomeUnico('Caio'));

    const texto = `mensagem de teste ${Date.now()}`;
    await enviar(paginaA, texto);

    // O ponto do teste: a mensagem sai de uma réplica e chega na outra ponta,
    // possivelmente atendida por outra réplica, atravessando o backplane.
    await expect(balaoComTexto(paginaB, texto)).toBeVisible();
    await expect(paginaB.locator('.message-row').last()).toContainText(nomeA);

    await contextoA.close();
    await contextoB.close();
  });

  test('conversa privada só aparece para os dois participantes', async ({ browser }) => {
    const contextos = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext()
    ]);
    const [paginaA, paginaB, paginaC] = await Promise.all(contextos.map(c => c.newPage()));

    const nomeA = nomeUnico('Dani');
    const nomeB = nomeUnico('Edu');
    await entrar(paginaA, nomeA);
    await entrar(paginaB, nomeB);
    await entrar(paginaC, nomeUnico('Fabi'));

    // A pessoa precisa aparecer na lista de quem está online antes de dar pra
    // abrir conversa com ela.
    const conversaComB = paginaA.locator('.conversation-item').filter({ hasText: nomeB });
    await expect(conversaComB).toBeVisible();
    await conversaComB.click();

    const segredo = `mensagem privada ${Date.now()}`;
    await enviar(paginaA, segredo);

    // B está com a Sala Geral aberta, então a mensagem não aparece na hora: o
    // que surge é o aviso de não lida ao lado do nome de quem mandou. Só depois
    // de abrir a conversa é que o conteúdo aparece. Esse é o fluxo real, e a
    // primeira versão deste teste falhava justamente por pular essa etapa.
    const conversaComA = paginaB.locator('.conversation-item').filter({ hasText: nomeA });
    await expect(conversaComA.locator('.unread-dot')).toBeVisible();
    await conversaComA.click();

    await expect(balaoComTexto(paginaB, segredo)).toBeVisible();

    // Quem não é destinatário não pode ver, nem na Sala Geral nem em lugar
    // nenhum. Espera explícita antes de afirmar ausência, senão o teste
    // passaria só por ter olhado cedo demais.
    await paginaC.waitForTimeout(1500);
    await expect(balaoComTexto(paginaC, segredo)).toHaveCount(0);

    await Promise.all(contextos.map(c => c.close()));
  });

  test('mensagens seguidas da mesma pessoa não repetem avatar e nome', async ({ page }) => {
    await entrar(page, nomeUnico('Gabi'));

    const marca = Date.now();
    await enviar(page, `primeira ${marca}`);
    await expect(balaoComTexto(page, `primeira ${marca}`)).toBeVisible();
    await enviar(page, `segunda ${marca}`);
    await expect(balaoComTexto(page, `segunda ${marca}`)).toBeVisible();

    const linhas = page.locator('.message-row');
    const ultima = linhas.last();
    await expect(ultima).toHaveClass(/seguida/);
    await expect(ultima.locator('img.avatar')).toHaveCount(0);
    await expect(ultima.locator('.message-info')).toHaveCount(0);
    // O horário fica dentro do balão, não numa linha separada acima.
    await expect(ultima.locator('.message-bubble .message-time')).toBeVisible();
  });
});

test.describe('resiliência', () => {
  test('a conversa sobrevive a recarregar a página', async ({ page }) => {
    await entrar(page, nomeUnico('Helo'));

    const texto = `antes do reload ${Date.now()}`;
    await enviar(page, texto);
    await expect(balaoComTexto(page, texto)).toBeVisible();

    await page.reload();

    // O servidor devolve as últimas mensagens da sala em OnConnectedAsync, e é
    // isso que faz recarregar não cair numa tela vazia.
    await expect(balaoComTexto(page, texto)).toBeVisible();
  });

  test('a mesma aba reconecta sem ser recusada pelo próprio nome', async ({ page }) => {
    const nome = nomeUnico('Ivo');
    await entrar(page, nome);
    const replicaAntes = await replicaAtual(page);

    // Recarregar cria uma conexão nova enquanto a antiga ainda está registrada.
    // Sem o identificador estável por aba, a checagem de nome único recusaria a
    // própria pessoa que está voltando.
    await page.reload();

    await expect(seloDoServidor(page)).toContainText(/Servidor [ABC]/);
    await expect(page.locator('.error-text')).toHaveCount(0);
    expect(replicaAntes).toMatch(/Servidor [ABC]/);
  });
});

test.describe('visualizador de arquitetura', () => {
  test('mostra as três réplicas e posiciona a pessoa na réplica certa', async ({ page }) => {
    const nome = nomeUnico('Joana');
    await entrar(page, nome);

    const minhaReplica = await replicaAtual(page);

    const grupos = page.locator('.viz-people-group');
    await expect(grupos).toHaveCount(3);

    // O visualizador e o selo do cabeçalho leem a mesma verdade por caminhos
    // diferentes: o selo vem de um evento direto ao cliente, e o painel vem da
    // presença registrada no Redis. Se os dois concordam, a presença está certa.
    const grupoDaMinhaReplica = grupos.filter({ hasText: minhaReplica });
    await expect(grupoDaMinhaReplica.locator('.viz-name').filter({ hasText: nome })).toBeVisible();
  });
});
