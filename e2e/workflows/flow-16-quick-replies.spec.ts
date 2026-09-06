/**
 * Fluxo 16: respostas rápidas — a Onda 2 da spec
 * `2026-09-05-onda-8-atendimento-design.md` (§3).
 *
 * O §7 da spec exige verificação em NAVEGADOR de verdade, não só em jsdom, e
 * cada peça aqui é provada pelo EFEITO:
 *
 *  - a macro criada na tela existe **no servidor** (o teste relê pela API);
 *  - a `/` no Composer traz a macro e ESCREVE o conteúdo no campo — que é a
 *    metade que o unitário não pode garantir, porque depende de foco, cursor e
 *    ordem real dos eventos do navegador;
 *  - a atendente (não só gestor) cria e apaga: a permissão da tela é o ponto
 *    da decisão de §3.1, e uma tela `MANAGER_PLUS` passaria despercebida;
 *  - `/` no meio do texto continua sendo texto ("24/48h").
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ListQuickRepliesResponse, QuickReply } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
} from './helpers.js';

/** Atalho único por execução: a suíte roda contra a mesma stack várias vezes. */
function uniqueShortcut(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`.slice(0, 32);
}

async function fetchQuickReplies(
  request: APIRequestContext,
  token: string,
): Promise<QuickReply[]> {
  const response = await request.get(`${API_URL}/quick-replies`, { headers: authHeaders(token) });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as ListQuickRepliesResponse).quickReplies;
}

/** Limpeza: a tela apaga de verdade, e a suíte não pode deixar lixo na lista. */
async function deleteQuickReply(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<void> {
  const response = await request.delete(`${API_URL}/quick-replies/${id}`, {
    headers: authHeaders(token),
  });
  expect([204, 404]).toContain(response.status());
}

async function createQuickReplyViaApi(
  request: APIRequestContext,
  token: string,
  body: { shortcut: string; title: string; content: string },
): Promise<QuickReply> {
  const response = await request.post(`${API_URL}/quick-replies`, {
    headers: authHeaders(token),
    data: body,
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as QuickReply;
}

async function abrirAtendimento(page: Page): Promise<void> {
  await page.goto('/attendance');
  await expect(page.getByTestId('conversation-item').first()).toBeVisible();
}

test.describe('Onda 8 §3 — respostas rápidas', () => {
  test('a ATENDENTE cria a macro pela tela e ela existe no servidor', async ({ page, request }) => {
    const ana = E2E_USERS.alfaAttendant;
    const token = await apiLogin(request, ana);
    const shortcut = uniqueShortcut('coleta');
    const content = 'Coleta de segunda a sexta, das 6h30 às 11h, sem agendamento.';

    await loginAs(page, ana);
    await gotoScreen(page, '/quick-replies', 'Respostas rápidas');

    await page.getByRole('button', { name: /nova resposta/i }).click();
    await page.getByLabel('Atalho').fill(shortcut);
    await page.getByLabel('Título').fill('Horário de coleta');
    // `getByRole` e não `getByLabel`: o próprio diálogo se chama "Nova resposta
    // rápida", e o nome acessível dele casa com /Resposta/ do mesmo jeito.
    await page.getByRole('textbox', { name: 'Resposta' }).fill(content);

    const post = page.waitForResponse(
      (res) => res.url().endsWith('/quick-replies') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /^criar$/i }).click();
    expect((await post).status()).toBe(201);

    // Prova pelo servidor, não pelo DOM: a lista da tela poderia estar em cache.
    const saved = (await fetchQuickReplies(request, token)).find((r) => r.shortcut === shortcut);
    expect(saved?.content).toBe(content);

    await expect(page.getByText(`/${shortcut}`)).toBeVisible();

    if (saved) await deleteQuickReply(request, token, saved.id);
  });

  test('"/" no Composer traz a macro e escreve o conteúdo no campo', async ({ page, request }) => {
    const ana = E2E_USERS.alfaAttendant;
    const token = await apiLogin(request, ana);
    const shortcut = uniqueShortcut('jejum');
    const content = 'Para glicemia, o jejum é de 8 horas.';
    const macro = await createQuickReplyViaApi(request, token, {
      shortcut,
      title: 'Jejum',
      content,
    });

    await loginAs(page, ana);
    await abrirAtendimento(page);
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: E2E_CONVERSATIONS.atribuida.patientName })
      .click();

    const campo = page.getByLabel('Mensagem');
    await campo.click();
    await campo.type('/');
    await expect(page.getByRole('listbox', { name: 'Respostas rápidas' })).toBeVisible();

    // Filtra pelo atalho e escolhe pelo teclado — o caminho que a atendente usa.
    await campo.type(shortcut.slice(0, 5));
    await page.getByRole('option', { name: new RegExp(shortcut) }).click();

    await expect(campo).toHaveValue(content);

    await deleteQuickReply(request, token, macro.id);
  });

  test('"/" no MEIO do texto continua sendo texto — "24/48h" não abre menu', async ({
    page,
    request,
  }) => {
    const ana = E2E_USERS.alfaAttendant;
    const token = await apiLogin(request, ana);
    const macro = await createQuickReplyViaApi(request, token, {
      shortcut: uniqueShortcut('prazo'),
      title: 'Prazo',
      content: 'O resultado sai em 24 horas.',
    });

    await loginAs(page, ana);
    await abrirAtendimento(page);
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: E2E_CONVERSATIONS.atribuida.patientName })
      .click();

    const campo = page.getByLabel('Mensagem');
    await campo.click();
    await campo.type('o resultado sai em 24/48h');

    await expect(page.getByRole('listbox', { name: 'Respostas rápidas' })).toHaveCount(0);
    await expect(campo).toHaveValue('o resultado sai em 24/48h');

    await deleteQuickReply(request, token, macro.id);
  });

  test('apagar pede confirmação e a macro some da lista', async ({ page, request }) => {
    const ana = E2E_USERS.alfaAttendant;
    const token = await apiLogin(request, ana);
    const shortcut = uniqueShortcut('apagar');
    const macro = await createQuickReplyViaApi(request, token, {
      shortcut,
      title: 'Para apagar',
      content: 'Este texto vai embora.',
    });

    await loginAs(page, ana);
    await gotoScreen(page, '/quick-replies', 'Respostas rápidas');
    await expect(page.getByText(`/${shortcut}`)).toBeVisible();

    await page.getByRole('button', { name: `Apagar /${shortcut}` }).click();
    const del = page.waitForResponse(
      (res) => res.url().includes('/quick-replies/') && res.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /^apagar$/i }).click();
    expect((await del).status()).toBe(204);

    await expect(page.getByText(`/${shortcut}`)).toHaveCount(0);
    expect((await fetchQuickReplies(request, token)).map((r) => r.id)).not.toContain(macro.id);
  });
});
