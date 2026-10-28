/**
 * Fluxo: confirmacao de leitura no Chat Interno (DM) — CRMLAB-123, D-300/D-301.
 *
 * A (Ana Atendente) escreve para B (Gustavo Gestor) numa DM. Enquanto B nao
 * abre, a mensagem de A mostra ✓ cinza; B abre a DM (`POST .../read`) e o tique
 * de A vira ✓✓ azul SEM recarregar — pelo WS `internal_chat.channel_read`, que
 * refaz `GET .../messages` (o `readState` vem nele). Nenhum polling.
 *
 * Escrito no CRMLAB-123 e NAO executado no worktree do card (regra da release
 * v1.42.0: Playwright roda so na integracao). Cada execucao manda uma mensagem
 * com texto unico, entao o teste nao depende do estado deixado por outra rodada.
 */
import { test, expect } from '@playwright/test';
import type { Channel, InternalMessage } from '@crm-lab/shared';
import {
  API_URL,
  E2E_USERS,
  apiLogin,
  authHeaders,
  channelButton,
  loginAs,
  markChannelRead,
} from './helpers.js';

test.describe('Fluxo: ✓/✓✓ no Chat Interno (CRMLAB-123)', () => {
  test('DM: ✓ ate o outro abrir; ✓✓ azul sem recarregar quando ele abre', async ({
    page,
    request,
  }) => {
    const ana = await apiLogin(request, E2E_USERS.alfaAttendant);
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);

    const dmResponse = await request.post(`${API_URL}/internal-chat/dms`, {
      headers: authHeaders(ana),
      data: { userId: E2E_USERS.alfaManager.id },
    });
    expect(dmResponse.status()).toBe(200);
    const dm = (await dmResponse.json()) as Channel;

    // O gestor le o que ja havia antes, para a mensagem nova ser a unica pendente.
    await markChannelRead(request, gestor, dm.id);

    const text = `Confirmação de leitura ${Date.now()}`;
    const sent = await request.post(`${API_URL}/internal-chat/channels/${dm.id}/messages`, {
      headers: authHeaders(ana),
      data: { content: text },
    });
    expect(sent.status()).toBe(201);
    const message = (await sent.json()) as InternalMessage;
    expect(message.content).toBe(text);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto('/internal-chat');
    await channelButton(page, E2E_USERS.alfaManager.name).click();

    const bubble = page.getByTestId('internal-message').filter({ hasText: text });
    const tick = bubble.getByTestId('message-status');
    await expect(tick).toHaveAttribute('data-status', 'sent');
    await expect(tick).toHaveText('✓');

    // B abre a DM (fora da tela de A). A tela de A NAO recarrega.
    await markChannelRead(request, gestor, dm.id);

    await expect(tick).toHaveAttribute('data-status', 'read');
    await expect(tick).toHaveText('✓✓');
    await expect(tick).toHaveAccessibleName('Lida');
  });

  test('mensagem de outra pessoa nao leva indicador', async ({ page, request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const dm = (await (
      await request.post(`${API_URL}/internal-chat/dms`, {
        headers: authHeaders(gestor),
        data: { userId: E2E_USERS.alfaAttendant.id },
      })
    ).json()) as Channel;

    const text = `Do gestor ${Date.now()}`;
    const sent = await request.post(`${API_URL}/internal-chat/channels/${dm.id}/messages`, {
      headers: authHeaders(gestor),
      data: { content: text },
    });
    expect(sent.status()).toBe(201);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto('/internal-chat');
    await channelButton(page, E2E_USERS.alfaManager.name).click();

    const bubble = page.getByTestId('internal-message').filter({ hasText: text });
    await expect(bubble).toBeVisible();
    await expect(bubble.getByTestId('message-status')).toHaveCount(0);
  });
});
