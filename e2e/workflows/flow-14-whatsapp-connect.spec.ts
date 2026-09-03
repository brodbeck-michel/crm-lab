/**
 * Fluxo 14: Conexao do WhatsApp por QR — API_CONTRACTS.md §6.1, D-083
 * (Onda 7, Bloco B).
 *
 * O caminho inteiro, ponta a ponta: navegador -> backend -> gateway Evolution.
 * O gateway aqui e falso (`fake-evolution-gateway.ts`), mas e um servidor HTTP
 * de verdade — o backend roda em outro processo e so fala com o gateway por
 * HTTP; nao ha objeto para injetar de dentro do teste.
 *
 * PRE-REQUISITO DO AMBIENTE: o backend precisa apontar `EVOLUTION_API_URL`
 * para a porta deste gateway falso (padrao 8080, a mesma do servico
 * `evolution` do compose) e ter `EVOLUTION_API_KEY`/`EVOLUTION_WEBHOOK_TOKEN`
 * preenchidos — sem os tres, as rotas de QR respondem 503
 * `CHANNEL_QR_UNAVAILABLE` por contrato. `backend/.env.example` traz os tres.
 * Com o container `evolution` de pe, a porta esta ocupada e o gateway falso
 * falha na subida com a mensagem dizendo isso (nunca um falso-verde).
 *
 * TENANT: **Beta**, nao Alfa. Conectar por QR e uma troca de MODO do canal
 * (`connection_mode = 'qr'`, D-083) e nenhuma rota volta para `cloud_api` —
 * so o re-seed. No Alfa isso vazava para os fluxos seguintes: o envio de
 * mensagem do fluxo 8 passava a falar com um gateway que so existe enquanto
 * ESTE arquivo roda, e respondia 502. O Beta e o tenant que nenhum outro
 * fluxo usa para enviar mensagem. O `afterAll` ainda devolve o token semeado.
 */
import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import type { ChannelSettingsResponse, WhatsAppQrResponse, WhatsAppStatusResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_TENANT_CHANNELS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
} from './helpers.js';
import {
  FAKE_OWNER_PHONE,
  startFakeEvolutionGateway,
  type FakeEvolutionGateway,
} from './fake-evolution-gateway.js';

const BETA_WHATSAPP = E2E_TENANT_CHANNELS.betaWhatsapp;

let gateway: FakeEvolutionGateway;

async function disconnect(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${API_URL}/settings/channels/whatsapp/disconnect`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(204);
}

test.beforeAll(async () => {
  gateway = await startFakeEvolutionGateway();
});

test.afterAll(async () => {
  // `request` e fixture de TESTE — em `afterAll` so existem as de worker, entao
  // o contexto de API e criado a mao aqui.
  const api = await playwrightRequest.newContext();
  try {
    // Devolve o token semeado: `connectWhatsAppQr` grava a apikey da instancia
    // em `api_token`, e a mascara desse campo e contrato de `E2E_TENANT_CHANNELS`.
    const token = await apiLogin(api, E2E_USERS.betaAdmin);
    const restaurado = await api.patch(`${API_URL}/settings/channels`, {
      headers: authHeaders(token),
      data: { channels: [{ channel: 'whatsapp', apiToken: BETA_WHATSAPP.apiToken }] },
    });
    expect(restaurado.status(), await restaurado.text()).toBe(200);
  } finally {
    await api.dispose();
    await gateway.close();
  }
});

test.describe('Fluxo 14: conexao WhatsApp por QR', () => {
  test('sem aceitar o termo, a API recusa a conexao', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.betaAdmin);
    const response = await request.post(`${API_URL}/settings/channels/whatsapp/connect`, {
      headers: authHeaders(token),
      data: {},
    });

    // O aceite ainda nao existe para o tenant semeado — 400 com o campo dito.
    expect(response.status(), await response.text()).toBe(400);
    const corpo = (await response.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe('VALIDATION_ERROR');
  });

  test('atendente nao conecta: a rota de QR e do admin', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.betaAttendant);
    const response = await request.post(`${API_URL}/settings/channels/whatsapp/connect`, {
      headers: authHeaders(token),
      data: { acceptTerms: true },
    });
    expect(response.status()).toBe(403);
  });

  test('admin conecta pela tela: termo -> QR -> conectado', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.betaAdmin);
    await gotoScreen(page, '/settings/channels', 'Canais & Equipe');

    await page.getByRole('button', { name: 'Conectar WhatsApp' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Conectar WhatsApp por QR')).toBeVisible();

    // Sem o aceite o botao nao esta disponivel — a UI nao antecipa o 400.
    const conectar = modal.getByRole('button', { name: 'Conectar', exact: true });
    await expect(conectar).toBeDisabled();

    await modal.getByRole('checkbox').check();
    await expect(conectar).toBeEnabled();
    await conectar.click();

    // 1a resposta do gateway: QR para escanear.
    await expect(modal.getByAltText('QR Code do WhatsApp')).toBeVisible();

    // 2a resposta (polling de ~2s): o celular "pareou" — o modal fecha sozinho.
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('WhatsApp conectado.')).toBeVisible();

    // O cartao passa a mostrar o numero pareado (o estado do canal vem do
    // servidor: recarregar prova que nao e memoria de tela).
    await page.reload();
    await expect(page.getByText(`Conectado — ${FAKE_OWNER_PHONE}`)).toBeVisible();

    // E o estado que a API reporta bate com o que a tela mostra.
    const token = await apiLogin(request, E2E_USERS.betaAdmin);
    const status = (await (
      await request.get(`${API_URL}/settings/channels/whatsapp/status`, {
        headers: authHeaders(token),
      })
    ).json()) as WhatsAppStatusResponse;
    expect(status.status).toBe('connected');
    expect(status.phoneNumber).toBe(FAKE_OWNER_PHONE);

    const settings = (await (
      await request.get(`${API_URL}/settings/channels`, { headers: authHeaders(token) })
    ).json()) as ChannelSettingsResponse;
    const canal = settings.channels.find((item) => item.channel === 'whatsapp');
    expect(canal?.connectionMode).toBe('qr');
    expect(canal?.acceptedTermsAt).not.toBeNull();
    // A apikey da instancia nunca sai em claro — mesma regra do token cloud_api.
    expect(JSON.stringify(settings)).not.toContain('fake-instance-apikey');
  });

  test('reconexao reusa o aceite ja gravado (corpo vazio nao toma 400)', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.betaAdmin);
    // Desconectar primeiro: o gateway falso volta a emitir QR do zero.
    await disconnect(request, token);

    const response = await request.post(`${API_URL}/settings/channels/whatsapp/connect`, {
      headers: authHeaders(token),
      data: {},
    });
    expect(response.status(), await response.text()).toBe(200);
    const corpo = (await response.json()) as WhatsAppQrResponse;
    expect(corpo.status).toBe('pairing');
    expect(corpo.qrcode).not.toBeNull();
    expect(corpo.expiresInSeconds).not.toBeNull();

    await disconnect(request, token);
    const depois = (await (
      await request.get(`${API_URL}/settings/channels/whatsapp/status`, {
        headers: authHeaders(token),
      })
    ).json()) as WhatsAppStatusResponse;
    expect(depois.status).not.toBe('connected');
  });
});
