/**
 * Fluxo 15: ferramentas de atendimento da Onda 1 — transferência, emoji e
 * fixar (spec `2026-09-05-onda-8-atendimento-design.md` §2).
 *
 * Por que este spec existe além dos unitários: o §7 da spec exige verificação
 * em NAVEGADOR de verdade, e foi ela que revelou os bugs que a suíte em jsdom
 * não pegava na v1.2.0. Aqui cada peça é provada pelo EFEITO, não pelo clique:
 *
 *  - transferir: a conversa muda de dona **no servidor** (o teste relê pela
 *    API) e a mensagem de sistema aparece na conversa;
 *  - emoji: entra na POSIÇÃO DO CURSOR e a mensagem enviada carrega o emoji;
 *  - fixar: a conversa sobe para o topo da MINHA lista e continua fixada
 *    depois do reload — e o pin **não** aparece para outra pessoa.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { ConversationDetail, ListConversationsResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  loginAs,
  logout,
} from './helpers.js';

/**
 * A tela de Atendimento nao tem `<h1>` (e um inbox de 3 colunas), entao
 * `gotoScreen` nao serve: a ancora de "carregou" e a propria fila.
 */
async function abrirAtendimento(page: Page): Promise<void> {
  await page.goto('/attendance');
  await expect(page.getByTestId('conversation-item').first()).toBeVisible();
}

async function fetchConversation(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<ConversationDetail> {
  const response = await request.get(`${API_URL}/conversations/${id}`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { conversation: ConversationDetail }).conversation;
}

async function fetchList(
  request: APIRequestContext,
  token: string,
  scope: string,
): Promise<ListConversationsResponse> {
  const response = await request.get(`${API_URL}/conversations?scope=${scope}&status=active`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ListConversationsResponse;
}

test.describe('Onda 8 §2 — transferência, emoji e fixar', () => {
  test('transferir pelo menu passa a conversa para a colega escolhida', async ({
    page,
    request,
  }) => {
    const ana = E2E_USERS.alfaAttendant;
    const gestor = E2E_USERS.alfaManager;
    const conversa = E2E_CONVERSATIONS.atribuida;

    await loginAs(page, ana);
    await abrirAtendimento(page);
    await page.getByTestId('conversation-item').filter({ hasText: conversa.patientName }).click();

    // A conversa é da Ana → o botão é "Transferir" e ela não se lista.
    await page.getByRole('button', { name: 'Transferir' }).click();
    await expect(page.getByRole('menuitem', { name: ana.name })).toHaveCount(0);

    const patch = page.waitForResponse(
      (res) => res.url().includes(`/conversations/${conversa.id}`) && res.status() === 200,
    );
    await page.getByRole('menuitem', { name: gestor.name }).click();
    await patch;

    // O EFEITO, lido do servidor — não a caixinha verde da tela.
    const token = await apiLogin(request, gestor);
    const depois = await fetchConversation(request, token, conversa.id);
    expect(depois.assignedTo).toBe(gestor.id);

    // WORKFLOWS §5: a transferência deixa mensagem de sistema no histórico.
    await expect(page.getByText(new RegExp(`transferida .*para ${gestor.name}`))).toBeVisible();

    // Devolve o cenário ao estado semeado — a suíte não semeia entre testes.
    await request.patch(`${API_URL}/conversations/${conversa.id}`, {
      headers: authHeaders(token),
      data: { assignedTo: ana.id },
    });
  });

  test('emoji entra na posição do cursor e vai junto na mensagem enviada', async ({ page }) => {
    const ana = E2E_USERS.alfaAttendant;
    const conversa = E2E_CONVERSATIONS.atribuida;

    await loginAs(page, ana);
    await abrirAtendimento(page);
    await page.getByTestId('conversation-item').filter({ hasText: conversa.patientName }).click();

    const campo = page.getByLabel('Mensagem');
    await campo.fill('bom dia tudo bem');
    // Cursor logo depois de "bom dia" — o navegador de verdade é quem move o
    // caret; jsdom só finge, e é por isso que este teste existe aqui.
    await campo.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));

    await page.getByRole('button', { name: 'Inserir emoji' }).click();
    await page.getByRole('button', { name: 'joinha' }).click();

    await expect(campo).toHaveValue('bom dia👍 tudo bem');

    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByText('bom dia👍 tudo bem')).toBeVisible();
  });

  test('fixar sobe a conversa na MINHA lista, sobrevive ao reload e não vaza para a colega', async ({
    page,
    request,
  }) => {
    const ana = E2E_USERS.alfaAttendant;
    const gestor = E2E_USERS.alfaManager;
    const conversa = E2E_CONVERSATIONS.aprovacao;

    await loginAs(page, ana);
    await abrirAtendimento(page);

    // O alfinete é IRMÃO do item (botão dentro de botão é HTML inválido), por
    // isso o rótulo nomeia a conversa em vez de o teste andar pela árvore.
    const fixar = page.getByRole('button', {
      name: `Fixar conversa com ${conversa.patientName}`,
    });
    const pin = page.waitForResponse(
      (res) => res.url().includes(`/conversations/${conversa.id}/pin`) && res.status() === 204,
    );
    await fixar.click();
    await pin;

    // Fixada é a PRIMEIRA da lista, e continua fixada depois do reload.
    await page.reload();
    const primeiro = page.getByTestId('conversation-item').first();
    await expect(primeiro).toContainText(conversa.patientName);
    await expect(
      page.getByRole('button', { name: `Desafixar conversa com ${conversa.patientName}` }),
    ).toBeVisible();

    // O pin é PESSOAL: para o gestor, a mesma conversa vem `pinned: false`.
    const tokenGestor = await apiLogin(request, gestor);
    const listaDoGestor = await fetchList(request, tokenGestor, 'all');
    const mesma = listaDoGestor.conversations.find((c) => c.id === conversa.id);
    expect(mesma?.pinned).toBe(false);

    // Desafixa: o estado da tela volta ao que estava antes do teste.
    await page
      .getByRole('button', { name: `Desafixar conversa com ${conversa.patientName}` })
      .click();
    await expect(
      page.getByRole('button', { name: `Fixar conversa com ${conversa.patientName}` }),
    ).toBeVisible();
    await logout(page);
  });
});
