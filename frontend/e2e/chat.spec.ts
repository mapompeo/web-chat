import { test, expect } from '@playwright/test';
import {
  bubbleWithText,
  signIn,
  sendMessage,
  uniqueName,
  currentReplica,
  serverBadge
} from './helpers';

test.describe('entrada no chat', () => {
  test('entra pela tela inicial e cai numa das réplicas', async ({ page }) => {
    await signIn(page, uniqueName('Ana'));

    // Qual das três atendeu não importa (quem decide é o load balancer), mas
    // tem que ser uma delas, e o indicador tem que estar verde.
    await expect(serverBadge(page)).toContainText(/Servidor [ABC]/);
    await expect(serverBadge(page)).not.toHaveClass(/is-down/);
  });

  test('recusa um nome que já está em uso', async ({ browser }) => {
    const name = uniqueName('Duplicada');

    const firstContext = await browser.newContext();
    const originalPage = await firstContext.newPage();
    await signIn(originalPage, name);

    // Contexto separado, e não outra aba: o identificador de cliente vive no
    // sessionStorage, e a mesma aba reconectando é justamente o caso que DEVE
    // ser aceito. Aqui queremos outra pessoa querendo o mesmo nome.
    const secondContext = await browser.newContext();
    const intruderPage = await secondContext.newPage();
    await intruderPage.goto(`/chat?user=${encodeURIComponent(name)}`);

    await expect(intruderPage.locator('.error-text')).toContainText('já está em uso');

    await firstContext.close();
    await secondContext.close();
  });
});

test.describe('conversa', () => {
  test('mensagem da Sala Geral chega para a outra pessoa', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const nameA = uniqueName('Bia');
    await signIn(pageA, nameA);
    await signIn(pageB, uniqueName('Caio'));

    const text = `mensagem de teste ${Date.now()}`;
    await sendMessage(pageA, text);

    // O ponto do teste: a mensagem sai de uma réplica e chega na outra ponta,
    // possivelmente atendida por outra réplica, atravessando o backplane.
    await expect(bubbleWithText(pageB, text)).toBeVisible();
    await expect(pageB.locator('.message-row').last()).toContainText(nameA);

    await contextA.close();
    await contextB.close();
  });

  test('conversa privada só aparece para os dois participantes', async ({ browser }) => {
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext()
    ]);
    const [pageA, pageB, pageC] = await Promise.all(contexts.map(c => c.newPage()));

    const nameA = uniqueName('Dani');
    const nameB = uniqueName('Edu');
    await signIn(pageA, nameA);
    await signIn(pageB, nameB);
    await signIn(pageC, uniqueName('Fabi'));

    // A pessoa precisa aparecer na lista de quem está online antes de dar pra
    // abrir conversa com ela.
    const conversationWithB = pageA.locator('.conversation-item').filter({ hasText: nameB });
    await expect(conversationWithB).toBeVisible();
    await conversationWithB.click();

    const secret = `mensagem privada ${Date.now()}`;
    await sendMessage(pageA, secret);

    // B está com a Sala Geral aberta, então a mensagem não aparece na hora: o
    // que surge é o aviso de não lida ao lado do nome de quem mandou. Só depois
    // de abrir a conversa é que o conteúdo aparece. Esse é o fluxo real, e a
    // primeira versão deste teste falhava justamente por pular essa etapa.
    const conversationWithA = pageB.locator('.conversation-item').filter({ hasText: nameA });
    await expect(conversationWithA.locator('.unread-dot')).toBeVisible();
    await conversationWithA.click();

    await expect(bubbleWithText(pageB, secret)).toBeVisible();

    // Quem não é destinatário não pode ver, nem na Sala Geral nem em lugar
    // nenhum. Espera explícita antes de afirmar ausência, senão o teste
    // passaria só por ter olhado cedo demais.
    await pageC.waitForTimeout(1500);
    await expect(bubbleWithText(pageC, secret)).toHaveCount(0);

    await Promise.all(contexts.map(c => c.close()));
  });

  test('mensagens seguidas da mesma pessoa não repetem avatar e nome', async ({ page }) => {
    await signIn(page, uniqueName('Gabi'));

    const stamp = Date.now();
    await sendMessage(page, `primeira ${stamp}`);
    await expect(bubbleWithText(page, `primeira ${stamp}`)).toBeVisible();
    await sendMessage(page, `segunda ${stamp}`);
    await expect(bubbleWithText(page, `segunda ${stamp}`)).toBeVisible();

    const rows = page.locator('.message-row');
    const lastRow = rows.last();
    await expect(lastRow).toHaveClass(/follow-up/);
    await expect(lastRow.locator('img.avatar')).toHaveCount(0);
    await expect(lastRow.locator('.message-info')).toHaveCount(0);
    // O horário fica dentro do balão, não numa linha separada acima.
    await expect(lastRow.locator('.message-bubble .message-time')).toBeVisible();
  });
});

test.describe('resiliência', () => {
  test('a conversa sobrevive a recarregar a página', async ({ page }) => {
    await signIn(page, uniqueName('Helo'));

    const text = `antes do reload ${Date.now()}`;
    await sendMessage(page, text);
    await expect(bubbleWithText(page, text)).toBeVisible();

    await page.reload();

    // O servidor devolve as últimas mensagens da sala em OnConnectedAsync, e é
    // isso que faz recarregar não cair numa tela vazia.
    await expect(bubbleWithText(page, text)).toBeVisible();
  });

  test('a mesma aba reconecta sem ser recusada pelo próprio nome', async ({ page }) => {
    const name = uniqueName('Ivo');
    await signIn(page, name);
    const replicaBefore = await currentReplica(page);

    // Recarregar cria uma conexão nova enquanto a antiga ainda está registrada.
    // Sem o identificador estável por aba, a checagem de nome único recusaria a
    // própria pessoa que está voltando.
    await page.reload();

    await expect(serverBadge(page)).toContainText(/Servidor [ABC]/);
    await expect(page.locator('.error-text')).toHaveCount(0);
    expect(replicaBefore).toMatch(/Servidor [ABC]/);
  });
});

test.describe('visualizador de arquitetura', () => {
  test('mostra as três réplicas e posiciona a pessoa na réplica certa', async ({ page }) => {
    const name = uniqueName('Joana');
    await signIn(page, name);

    const myReplica = await currentReplica(page);

    const groups = page.locator('.viz-people-group');
    await expect(groups).toHaveCount(3);

    // O visualizador e o selo do cabeçalho leem a mesma verdade por caminhos
    // diferentes: o selo vem de um evento direto ao cliente, e o painel vem da
    // presença registrada no Redis. Se os dois concordam, a presença está certa.
    const myReplicaGroup = groups.filter({ hasText: myReplica });
    await expect(myReplicaGroup.locator('.viz-name').filter({ hasText: name })).toBeVisible();
  });
});
