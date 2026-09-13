/**
 * Fluxo 18: Vendas e comissão (PAGES.md §17, BUSINESS_RULES.md §11,
 * API_CONTRACTS.md §11/§12). Pendência registrada no STATUS.md ao fim da
 * Onda 10 — cobre o caminho real que os testes de componente não alcançam:
 *
 *  - gestor lança venda PARA um atendente (seletor "Atendente" só aparece
 *    para gestor/admin, D-112);
 *  - atendente SEM vínculo em `attendants` recebe `SALE_ATTENDANT_NOT_LINKED`
 *    com a mensagem certa, não um erro genérico de formulário;
 *  - depois de vinculado (`PATCH /attendants/:id`), o mesmo atendente lança
 *    a própria venda sem o seletor de atendente na tela.
 */
import { test, expect } from '@playwright/test';
import { API_URL, E2E_USERS, apiLogin, authHeaders, gotoScreen, loginAs } from './helpers.js';

const SALES = '/sales';
const HEADING = 'Vendas';
const ATTENDANT_NAME = 'Diego Vendedor E2E';

async function createAttendant(
  request: Parameters<typeof apiLogin>[0],
  token: string,
  name: string,
): Promise<string> {
  const response = await request.post(`${API_URL}/attendants`, {
    headers: authHeaders(token),
    data: { name },
  });
  if (response.status() === 201) {
    return ((await response.json()) as { id: string }).id;
  }
  expect(response.status(), await response.text()).toBe(409);
  const list = await request.get(`${API_URL}/attendants?search=${encodeURIComponent(name)}`, {
    headers: authHeaders(token),
  });
  expect(list.status(), await list.text()).toBe(200);
  const body = (await list.json()) as { attendants: Array<{ id: string; name: string }> };
  const existing = body.attendants.find((a) => a.name === name);
  if (!existing) throw new Error(`Atendente "${name}" não encontrado após CONFLICT`);
  return existing.id;
}

test.describe('Fluxo 18: Vendas', () => {
  test('gestor lança venda para um atendente e vê no resumo', async ({ page, request }) => {
    const managerToken = await apiLogin(request, E2E_USERS.alfaManager);
    await createAttendant(request, managerToken, ATTENDANT_NAME);

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, SALES, HEADING);

    await page.getByRole('button', { name: '+ Lançar venda' }).click();
    const dialog = page.getByRole('dialog', { name: 'Lançar venda' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Atendente').selectOption({ label: ATTENDANT_NAME });
    await dialog.getByLabel('Tipo').selectOption({ label: 'Exames' });
    await dialog.getByLabel('Valor').fill('250');
    await dialog.getByRole('button', { name: 'Lançar' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Venda lançada.' })).toBeVisible();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('row', { name: new RegExp(ATTENDANT_NAME) });
    await expect(row).toContainText('Exames');
    await expect(row).toContainText('R$ 250,00');

    // Comissão sobre exames: 1,5% (default D-113) de 250 = R$ 3,75.
    await expect(page.getByText('Comissão — Exames')).toBeVisible();
    const comissaoExamesCard = page.getByText('Comissão — Exames').locator('xpath=..');
    await expect(comissaoExamesCard).toContainText('R$ 3,75');
  });

  test('atendente sem vínculo recebe SALE_ATTENDANT_NOT_LINKED ao tentar lançar', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, SALES, HEADING);

    // Sem seletor de Atendente para o papel attendant (D-112).
    await expect(page.getByLabel('Atendente')).toHaveCount(0);

    await page.getByRole('button', { name: '+ Lançar venda' }).click();
    const dialog = page.getByRole('dialog', { name: 'Lançar venda' });
    await dialog.getByLabel('Tipo').selectOption({ label: 'Check-up' });
    await dialog.getByLabel('Valor').fill('100');
    await dialog.getByRole('button', { name: 'Lançar' }).click();

    await expect(
      page.getByRole('status').filter({
        hasText:
          'Seu usuário ainda não está ligado a um atendente — peça a um gestor para vincular em Configurações → Atendentes.',
      }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('depois de vinculado, o atendente lança a própria venda', async ({ page, request }) => {
    const managerToken = await apiLogin(request, E2E_USERS.alfaManager);
    const attendantId = await createAttendant(request, managerToken, ATTENDANT_NAME);

    const link = await request.patch(`${API_URL}/attendants/${attendantId}`, {
      headers: authHeaders(managerToken),
      data: { userId: E2E_USERS.alfaAttendant.id },
    });
    expect(link.status(), await link.text()).toBe(200);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, SALES, HEADING);
    await expect(page.getByLabel('Atendente')).toHaveCount(0);

    await page.getByRole('button', { name: '+ Lançar venda' }).click();
    const dialog = page.getByRole('dialog', { name: 'Lançar venda' });
    await dialog.getByLabel('Tipo').selectOption({ label: 'Check-up' });
    await dialog.getByLabel('Valor').fill('100');
    await dialog.getByRole('button', { name: 'Lançar' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Venda lançada.' })).toBeVisible();
    await expect(dialog).toBeHidden();

    // Login de atendente NAO mostra a coluna "Atendente" (é sempre a própria
    // venda) — a linha se identifica por tipo + valor.
    const row = page.getByRole('row', { name: /Check-up/ });
    await expect(row).toContainText('R$ 100,00');
  });
});
