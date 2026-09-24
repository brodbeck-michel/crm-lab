/**
 * Fluxo 19: encerrar atendimento (CRMLAB-48, D-174).
 *
 * Provado pelo EFEITO, como o fluxo 15: o clique em [Encerrar] muda o status
 * **no servidor** (o teste relê pela API), a conversa sai da fila e reaparece
 * no chip "Encerradas". Depois, um atendimento manual no mesmo telefone
 * reabre a conversa para quem cadastrou (D-174 item 4).
 *
 * A conversa nasce aqui, por `POST /conversations`, com telefone próprio: as
 * conversas semeadas são usadas por outros fluxos e encerrá-las mudaria o
 * cenário deles. A reabertura pelo PACIENTE (webhook assinado) fica nos testes
 * de integração do backend — a suíte e2e não assina webhook.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ConversationDetail } from '@crm-lab/shared';
import { API_URL, E2E_USERS, apiLogin, authHeaders, loginAs } from './helpers.js';

const PHONE = '(48) 98888-4819';
const PATIENT = 'Paciente Encerramento E2E';

async function createManual(
  request: APIRequestContext,
  token: string,
): Promise<ConversationDetail> {
  const response = await request.post(`${API_URL}/conversations`, {
    headers: authHeaders(token),
    data: { patientPhone: PHONE, patientName: PATIENT, channel: 'direct' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as ConversationDetail;
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

test.describe('CRMLAB-48 — encerrar atendimento', () => {
  test('a dona encerra: sai da fila, aparece em Encerradas e reabre no atendimento manual', async ({
    page,
    request,
  }) => {
    const ana = E2E_USERS.alfaAttendant;
    const token = await apiLogin(request, ana);
    const conversa = await createManual(request, token);
    expect(conversa.status).toBe('active');

    await loginAs(page, ana);
    await page.goto('/attendance');
    const item = page.getByTestId('conversation-item').filter({ hasText: PATIENT });
    await expect(item).toBeVisible();
    await item.click();

    const patch = page.waitForResponse(
      (res) => res.url().includes(`/conversations/${conversa.id}`) && res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Encerrar' }).click();
    expect((await patch).status()).toBe(200);

    // Efeito no servidor + a conversa sumiu da fila.
    expect((await fetchConversation(request, token, conversa.id)).status).toBe('closed');
    await expect(item).toHaveCount(0);

    // Chip "Encerradas" encontra a conversa, com o composer travado.
    await page.getByRole('button', { name: 'Encerradas' }).click();
    await expect(item).toBeVisible();
    await item.click();
    // Na bolha, nao na previa da lista — a frase aparece nas duas.
    await expect(
      page.getByTestId('message-bubble').filter({ hasText: `Atendimento encerrado por ${ana.name}` }),
    ).toBeVisible();
    await expect(page.getByLabel('Mensagem')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Encerrar' })).toBeDisabled();

    // Atendimento manual no mesmo telefone reabre para quem cadastrou (D-174).
    const reaberta = await createManual(request, token);
    expect(reaberta.id).toBe(conversa.id);
    expect(reaberta.status).toBe('active');
    expect(reaberta.assignedTo).toBe(ana.id);
  });
});
