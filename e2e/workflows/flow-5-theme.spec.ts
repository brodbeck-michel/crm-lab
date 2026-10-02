/**
 * Fluxo 5: Personalização — WORKFLOWS.md §9, PAGES.md §9.
 *
 * Cenario de TESTING.md: "admin troca tema -> cores mudam em tempo real ->
 * persiste apos relogin".
 *
 * O spec separa DE PROPOSITO duas coisas que costumam ser confundidas:
 *   (a) o tema salvo — `GET /themes/current` e a tela relendo o valor;
 *   (b) o tema APLICADO — a variavel CSS `--color-accent` no `<html>`, que e o
 *       que o usuario efetivamente enxerga em toda a aplicacao.
 *
 * Cada tenant tem seu proprio preset semeado, entao o teste usa o preset do
 * OUTRO tenant como alvo (uma cor real do catalogo, sem inventar hex) e
 * restaura o tema original no fim para nao contaminar as outras suites.
 *
 * D-250 (CRMLAB-82): o editor so troca accent, accent2, fonte, cantos, nome e
 * logo. Fundo e texto sao fixos (branco / escuro) — o `bg`/`surface`/`text`
 * salvos sao ignorados na tela, e o teste confere isso tambem.
 */
import { test, expect } from '@playwright/test';
import type { Theme } from '@crm-lab/shared';
import {
  API_URL,
  E2E_TENANTS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  currentAccent,
  fetchCurrentTheme,
  gotoScreen,
  loginAs,
} from './helpers.js';

const THEME_PATH = '/settings/theme';
const HEADING = 'Personalização';

/** Preset de origem (Alfa) e preset alvo — os dois vem das fixtures. */
const ORIGINAL = E2E_TENANTS.alfa;
const TARGET = E2E_TENANTS.beta;

test.describe('Fluxo 5: Personalização', () => {
  let saved: Theme | null = null;

  test.beforeEach(async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    saved = await fetchCurrentTheme(request, token);
  });

  test.afterEach(async ({ request }) => {
    if (!saved) return;
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    await request.patch(`${API_URL}/themes/current`, {
      headers: authHeaders(token),
      // A API continua aceitando bg/surface/text (contrato inalterado, D-250);
      // o teste de "ignorados na tela" grava valores coloridos neles.
      data: {
        accent: saved.accent,
        accent2: saved.accent2,
        bg: saved.bg,
        surface: saved.surface,
        text: saved.text,
        fontId: saved.fontId,
        radiusId: saved.radiusId,
      },
    });
    saved = null;
  });

  test('o tema do tenant chega aplicado logo apos o login', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const salvo = await fetchCurrentTheme(request, token);

    await loginAs(page, E2E_USERS.alfaAdmin);

    // D-005: o tema vem em `LoginResponse.tenant.theme` e e aplicado por
    // `applyTheme()` — sem request extra de tema no bootstrap.
    //
    // A comparacao e contra o tema GUARDADO, nao contra o hex semeado: um teste
    // anterior que morra no meio deixa o tenant com outra cor, e o invariante
    // ("o que o login manda e o que a tela pinta") continua sendo o mesmo.
    expect(await currentAccent(page)).toBe(salvo.accent.toLowerCase());
  });

  test('trocar de preset muda a previa e persiste apos reload', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, THEME_PATH, HEADING);

    // A previa comeca com o acento GUARDADO do tenant (o `beforeEach` acabou de
    // le-lo; comparar com o hex semeado tornaria o teste refem do estado do
    // banco entre execucoes).
    const preview = page.getByRole('heading', { name: 'Preview' }).locator('..');
    await expect(preview.getByText(saved?.accent ?? ORIGINAL.accent, { exact: false })).toBeVisible();

    // Aplica o preset alvo pelo nome do catalogo de temas.
    await page.getByRole('button', { name: new RegExp(TARGET.themeName) }).click();

    // A previa passa a mostrar o novo acento — sem reload.
    await expect(preview.getByText(TARGET.accent, { exact: false })).toBeVisible();

    // Persistiu no servidor. O preset so manda accent + accent2 (D-250):
    // fundo/superficie/texto guardados nao mudam.
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const salvo = await fetchCurrentTheme(request, token);
    expect(salvo.accent.toLowerCase()).toBe(TARGET.accent.toLowerCase());
    expect(salvo.bg).toBe(saved?.bg);
    expect(salvo.surface).toBe(saved?.surface);
    expect(salvo.text).toBe(saved?.text);

    // E continua la depois do reload da tela.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    await expect(preview.getByText(TARGET.accent, { exact: false })).toBeVisible();
  });

  test('a cor de acento aplicada acompanha a troca — na hora e apos reload', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, THEME_PATH, HEADING);

    await page.getByRole('button', { name: new RegExp(TARGET.themeName) }).click();
    await expect(
      page.getByRole('heading', { name: 'Preview' }).locator('..').getByText(TARGET.accent, { exact: false }),
    ).toBeVisible();

    // WORKFLOWS.md §9: "cores mudam em tempo real". O que o usuario ve e a
    // variavel CSS do `<html>`, nao o quadradinho da previa.
    expect(await currentAccent(page)).toBe(TARGET.accent.toLowerCase());

    // E continua aplicada depois de recarregar a aplicacao inteira.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible();
    expect(await currentAccent(page)).toBe(TARGET.accent.toLowerCase());
  });

  test('fundo branco e texto escuro fixos — bg/surface/text salvos sao ignorados (D-250)', async ({
    page,
    request,
  }) => {
    // Grava de proposito um fundo/texto colorido pela API (contrato inalterado).
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    await request.patch(`${API_URL}/themes/current`, {
      headers: authHeaders(token),
      data: { bg: TARGET.accent, surface: TARGET.accent, text: TARGET.accent },
    });

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, THEME_PATH, HEADING);

    const cores = await page.evaluate(() => ({
      inlineBg: document.documentElement.style.getPropertyValue('--color-bg'),
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
    }));
    expect(cores.inlineBg).toBe('');
    expect(cores.body).toBe('rgb(255, 255, 255)');
    expect(cores.text).toBe('rgb(26, 26, 26)');

    // E o editor nao oferece mais esses campos.
    await expect(page.getByLabel(/fundo/i)).toHaveCount(0);
    await expect(page.getByLabel(/superf/i)).toHaveCount(0);
    await expect(page.getByLabel(/cor do texto/i)).toHaveCount(0);
  });

  test('cor secundaria pelo campo hex tambem e salva', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, THEME_PATH, HEADING);

    await page.getByLabel('Cor secundária (hex)').fill(TARGET.accent);

    await expect(async () => {
      const token = await apiLogin(request, E2E_USERS.alfaAdmin);
      const salvo = await fetchCurrentTheme(request, token);
      expect(salvo.accent2.toLowerCase()).toBe(TARGET.accent.toLowerCase());
    }).toPass();
  });

  test('cor personalizada pelo campo hex tambem e salva', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, THEME_PATH, HEADING);

    // O campo aceita `#rrggbb`; o backend valida o mesmo formato.
    await page.getByLabel('Cor principal (hex)').fill(TARGET.accent);

    await expect(async () => {
      const token = await apiLogin(request, E2E_USERS.alfaAdmin);
      const salvo = await fetchCurrentTheme(request, token);
      expect(salvo.accent.toLowerCase()).toBe(TARGET.accent.toLowerCase());
    }).toPass();
  });

  test('trocar o tema de Alfa nao encosta no tema de Beta', async ({ request }) => {
    const atendenteBeta = await apiLogin(request, E2E_USERS.betaAttendant);
    const betaAntes = await fetchCurrentTheme(request, atendenteBeta);
    expect(betaAntes.accent.toLowerCase()).toBe(TARGET.accent.toLowerCase());

    const adminAlfa = await apiLogin(request, E2E_USERS.alfaAdmin);
    await request.patch(`${API_URL}/themes/current`, {
      headers: authHeaders(adminAlfa),
      data: { accent: TARGET.accent, bg: TARGET.accent, surface: TARGET.accent },
    });

    const betaDepois = await fetchCurrentTheme(request, atendenteBeta);
    expect(betaDepois).toEqual(betaAntes);
  });
});

test.describe('Fluxo 5: guarda de papel', () => {
  test('atendente nao alcança /settings/theme', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(THEME_PATH);

    // O guard devolve o atendente para a home do perfil dele.
    await expect(page).toHaveURL(/\/attendance$/);
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toHaveCount(0);
  });

  test('PATCH /themes/current e so admin — gestor leva FORBIDDEN', async ({ request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const response = await request.patch(`${API_URL}/themes/current`, {
      headers: authHeaders(gestor),
      data: { accent: TARGET.accent },
    });
    expect(response.status()).toBe(403);
  });
});
