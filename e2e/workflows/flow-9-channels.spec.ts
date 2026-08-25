/**
 * Fluxo 9: Canais & Equipe — PAGES.md §10, API_CONTRACTS.md §6
 * (D-064, D-065, D-066).
 *
 * O teste que mais importa deste arquivo e o do SEGREDO: salvar a tela com o
 * campo de token EM BRANCO tem que **preservar** o token guardado. A semantica
 * "ausente preserva · `null` apaga · string grava" e a parte desta tela em que
 * um engano derruba a integracao do laboratorio inteiro — e um teste que so
 * verificasse "o PATCH devolveu 200" passaria com o token apagado.
 *
 * Por isso a asserção vem em par:
 *   - salvar com o campo vazio NAO muda `apiTokenMasked` (nem `webhookSecretSet`);
 *   - **controle positivo**: escrever um token novo MUDA a mascara. Sem essa
 *     segunda metade, a primeira passaria tambem numa tela que simplesmente
 *     ignora o campo de token.
 *
 * E, em toda resposta, o valor em claro nunca aparece.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ChannelSettingsResponse, TenantChannel } from '@crm-lab/shared';
import {
  API_URL,
  E2E_TENANT_CHANNELS,
  E2E_TENANT_SETTINGS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  pageHeading,
  type ApiErrorEnvelope,
} from './helpers.js';

const CANAIS_PATH = '/settings/channels';
const HEADING = 'Canais & Equipe';

const ALFA_WHATSAPP = E2E_TENANT_CHANNELS.alfaWhatsapp;
const ALFA_SETTINGS = E2E_TENANT_SETTINGS.alfa;

/** Todos os segredos de teste que NUNCA podem sair do backend em claro. */
const SEGREDOS_EM_CLARO = [ALFA_WHATSAPP.apiToken, ALFA_WHATSAPP.webhookSecret] as const;

/**
 * Campo de escrita de um segredo.
 *
 * `getByLabel('Token da API')` NAO serve: o rotulo casa tambem a caixa
 * "Remover token da api ao salvar" (o `aria-label` do checkbox deriva do mesmo
 * texto), e o Playwright quebra em "strict mode violation". O papel desambigua
 * — `textbox` e o campo, `checkbox` e a remocao.
 */
function secretInput(page: Page, label: string): Locator {
  return page.getByRole('textbox', { name: label });
}

async function fetchSettings(
  request: APIRequestContext,
  token: string,
): Promise<ChannelSettingsResponse> {
  const response = await request.get(`${API_URL}/settings/channels`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as ChannelSettingsResponse;

  // Invariante do contrato §6, conferido em toda leitura desta suite.
  const serializado = JSON.stringify(body);
  for (const segredo of SEGREDOS_EM_CLARO) {
    expect(serializado, 'segredo em claro na resposta').not.toContain(segredo);
  }
  return body;
}

function whatsappOf(settings: ChannelSettingsResponse): TenantChannel {
  const canal = settings.channels.find((item) => item.channel === 'whatsapp');
  expect(canal, 'o tenant Alfa tem um canal whatsapp semeado').toBeDefined();
  return canal as TenantChannel;
}

test.describe('Fluxo 9: Canais & Equipe (admin edita)', () => {
  test('a tela carrega a configuracao semeada, com o token so em mascara', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const settings = await fetchSettings(request, token);
    const canal = whatsappOf(settings);

    // O contrato: mascara e presenca, nunca o valor.
    expect(canal.apiTokenMasked).toBe(ALFA_WHATSAPP.expectedApiTokenMasked);
    expect(canal.webhookSecretSet).toBe(true);
    expect(settings.distributionMode).toBe(ALFA_SETTINGS.distributionMode);

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, CANAIS_PATH, HEADING);

    await expect(page.getByLabel('Número', { exact: true })).toHaveValue(
      ALFA_WHATSAPP.phoneNumber,
    );
    await expect(page.getByLabel('ID do número no provedor')).toHaveValue(
      ALFA_WHATSAPP.phoneNumberId,
    );

    // A mascara aparece na tela; o valor em claro, em lugar nenhum do HTML.
    await expect(page.getByText(`Configurado (${ALFA_WHATSAPP.expectedApiTokenMasked})`)).toBeVisible();
    const html = await page.content();
    for (const segredo of SEGREDOS_EM_CLARO) {
      expect(html, 'segredo em claro no HTML da tela').not.toContain(segredo);
    }

    // O campo de escrita nasce VAZIO — e diz o que isso significa.
    await expect(secretInput(page, 'Token da API')).toHaveValue('');
    await expect(
      page.getByText('Campo em branco PRESERVA o valor atual. Digite algo apenas para substituí-lo.').first(),
    ).toBeVisible();
  });

  test('salvar com o campo de segredo EM BRANCO preserva o token', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const antes = whatsappOf(await fetchSettings(request, token));
    const novoNome = `WhatsApp QA ${Date.now()}`;

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, CANAIS_PATH, HEADING);

    await page.getByLabel('Nome exibido').fill(novoNome);
    // Deliberadamente NAO tocamos em "Token da API" nem em "Segredo do webhook".
    await expect(secretInput(page, 'Token da API')).toHaveValue('');
    await expect(secretInput(page, 'Segredo do webhook')).toHaveValue('');

    const salvo = page.waitForResponse(
      (res) => res.url().includes('/settings/channels') && res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    const resposta = await salvo;
    expect(resposta.status(), await resposta.text()).toBe(200);

    // A resposta do PATCH tambem nao traz segredo em claro.
    const corpo = await resposta.text();
    for (const segredo of SEGREDOS_EM_CLARO) {
      expect(corpo, 'segredo em claro na resposta do PATCH').not.toContain(segredo);
    }
    await expect(page.getByText('Configuração salva.')).toBeVisible();

    // O que importa: o segredo continua LA, e o campo editado persistiu.
    const depois = whatsappOf(await fetchSettings(request, token));
    expect(depois.apiTokenMasked).toBe(antes.apiTokenMasked);
    expect(depois.webhookSecretSet).toBe(antes.webhookSecretSet);
    expect(depois.displayName).toBe(novoNome);

    // E a tela recarregada mostra o nome novo com o token ainda mascarado.
    await page.reload();
    await expect(pageHeading(page, HEADING)).toBeVisible();
    await expect(page.getByLabel('Nome exibido')).toHaveValue(novoNome);
    await expect(page.getByText(`Configurado (${antes.apiTokenMasked})`)).toBeVisible();
  });

  test('o modo de distribuicao salvo pela tela persiste', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, CANAIS_PATH, HEADING);

    const grupo = page.getByRole('radiogroup', { name: 'Modo de distribuição' });
    await grupo.getByRole('radio').first().check();

    const salvo = page.waitForResponse(
      (res) => res.url().includes('/settings/channels') && res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    expect((await salvo).status()).toBe(200);

    expect((await fetchSettings(request, token)).distributionMode).toBe('manual');

    // Devolve ao valor do seed: as telas seguintes contam com `round_robin`.
    const volta = await request.patch(`${API_URL}/settings/channels`, {
      headers: authHeaders(token),
      data: { distributionMode: ALFA_SETTINGS.distributionMode },
    });
    expect(volta.status()).toBe(200);
    expect((await fetchSettings(request, token)).distributionMode).toBe(
      ALFA_SETTINGS.distributionMode,
    );
  });
});

test.describe('Fluxo 9: Canais & Equipe (gestor le)', () => {
  test('gestor ve a tela em modo leitura, sem nenhum controle de escrita', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, CANAIS_PATH, HEADING);

    // Controle positivo: a tela carregou com o dado do laboratorio.
    await expect(page.getByText(ALFA_WHATSAPP.phoneNumber).first()).toBeVisible();
    await expect(page.getByText(ALFA_WHATSAPP.phoneNumberId).first()).toBeVisible();
    await expect(
      page.getByText(`Configurado (${ALFA_WHATSAPP.expectedApiTokenMasked})`).first(),
    ).toBeVisible();
    // A equipe (D-066) vem junto com a configuracao.
    await expect(page.getByText(E2E_USERS.alfaAttendant.name).first()).toBeVisible();

    // E nao existe nada para escrever: nem botao, nem campo, nem toggle.
    await expect(page.getByText('Somente leitura').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salvar alterações' })).toHaveCount(0);
    await expect(page.getByLabel('Nome exibido')).toHaveCount(0);
    await expect(secretInput(page, 'Token da API')).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: 'Modo de distribuição' })).toHaveCount(0);
  });

  test('a API recusa o PATCH do gestor, e nada muda', async ({ request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const antes = whatsappOf(await fetchSettings(request, admin));

    const tentativa = await request.patch(`${API_URL}/settings/channels`, {
      headers: authHeaders(gestor),
      data: { channels: [{ channel: 'whatsapp', apiToken: null }] },
    });
    expect(tentativa.status()).toBe(403);
    expect(((await tentativa.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');

    // O token recusado continua guardado — a recusa nao apagou nada.
    const depois = whatsappOf(await fetchSettings(request, admin));
    expect(depois.apiTokenMasked).toBe(antes.apiTokenMasked);
    expect(depois.webhookSecretSet).toBe(true);
  });
});

test.describe('Fluxo 9: Canais & Equipe (atendente barrado)', () => {
  test('atendente e desviado da tela e recusado pela API', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const leitura = await request.get(`${API_URL}/settings/channels`, {
      headers: authHeaders(token),
    });
    expect(leitura.status()).toBe(403);
    expect(((await leitura.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');

    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(CANAIS_PATH);

    // O guard manda para a home do papel; a tela restrita nao chega a existir.
    await expect(page).toHaveURL(/\/attendance$/);
    await expect(pageHeading(page, HEADING)).toHaveCount(0);
  });
});

test.describe('Fluxo 9: Canais & Equipe (controle positivo do segredo)', () => {
  /**
   * Este teste fecha o par do "campo em branco preserva". Se a tela ou o
   * service simplesmente IGNORASSEM o campo de token, aquele teste passaria do
   * mesmo jeito — este aqui nao passaria.
   *
   * Roda por ultimo do arquivo de proposito: ele TROCA o token do canal — e NAO
   * o restaura (o valor original nunca volta pela API, so a mascara). Por isso o
   * sufixo do token novo e ALEATORIO, e nao `Date.now()`: com o tempo, um retry
   * dentro do mesmo segundo geraria a mesma mascara que o canal ja tem e a
   * guarda `mascaraEsperada !== antes.apiTokenMasked` falharia sozinha, sem
   * nenhuma regressao. O laco abaixo ainda garante que a mascara nova difere da
   * atual, entao o teste pode rodar quantas vezes for contra a mesma base.
   */
  test('escrever um token novo troca a mascara — e o novo valor tambem nao volta', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const antes = whatsappOf(await fetchSettings(request, token));

    let novoToken = '';
    let mascaraEsperada = '';
    do {
      novoToken = `EAAG-qa-rotacionado-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
      mascaraEsperada = `••••••••${novoToken.slice(-4)}`;
    } while (mascaraEsperada === antes.apiTokenMasked);

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, CANAIS_PATH, HEADING);
    await secretInput(page, 'Token da API').fill(novoToken);

    const salvo = page.waitForResponse(
      (res) => res.url().includes('/settings/channels') && res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    const resposta = await salvo;
    expect(resposta.status(), await resposta.text()).toBe(200);
    expect(await resposta.text(), 'o token recem-gravado nao pode voltar').not.toContain(novoToken);

    const depois = whatsappOf(await fetchSettings(request, token));
    expect(depois.apiTokenMasked).toBe(mascaraEsperada);
    // O segredo do webhook, que ficou em branco, continua intacto.
    expect(depois.webhookSecretSet).toBe(true);

    const leitura = await request.get(`${API_URL}/settings/channels`, {
      headers: authHeaders(token),
    });
    expect(await leitura.text()).not.toContain(novoToken);
  });
});
