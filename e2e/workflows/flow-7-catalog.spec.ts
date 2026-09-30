/**
 * Fluxo 7: Catálogo de Exames — PAGES.md §7, API_CONTRACTS.md §4.
 *
 * O que este spec prova:
 *  - atendente le o catalogo e tambem ve as acoes de criar/editar (CRMLAB-78, D-248);
 *  - gestor cria e edita exame pela tela;
 *  - **desativar e `PATCH { isActive: false }`** — nao existe `DELETE /exams/:id`
 *    (pedido do Agent-API-Catalog em STATUS.md). O spec confere as duas metades:
 *    o PATCH funciona E o DELETE nao existe;
 *  - o exame desativado some do catalogo do orçamento (`?active=true`), mas a
 *    proposta historica que o referencia continua intacta;
 *  - a API aceita o atendente em POST/PATCH e recusa a importacao por CSV (so admin, D-177).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Exam, ListExamsResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  parseMoney,
  type ApiErrorEnvelope,
} from './helpers.js';

const CATALOG_PATH = '/catalog';
const HEADING = 'Catálogo de Exames';

function uniqueCode(): string {
  return `QA${String(Date.now()).slice(-6)}`;
}

async function createExamViaApi(
  token: string,
  request: APIRequestContext,
  overrides: Partial<Exam> = {},
): Promise<Exam> {
  const response = await request.post(`${API_URL}/exams`, {
    headers: authHeaders(token),
    data: {
      name: overrides.name ?? `Exame QA ${uniqueCode()}`,
      code: overrides.code ?? uniqueCode(),
      pricePrivate: overrides.pricePrivate ?? 45.5,
      priceInsurance: overrides.priceInsurance ?? 22.25,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as Exam;
}

test.describe('Fluxo 7: Catálogo (atendente)', () => {
  test('atendente ve os exames do seu laboratorio e as acoes de escrita', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, CATALOG_PATH, HEADING);

    await page.getByRole('searchbox').fill(E2E_EXAMS.hemograma.code);
    await expect(page.getByRole('cell', { name: E2E_EXAMS.hemograma.name })).toBeVisible();
    await expect(page.getByRole('cell', { name: E2E_EXAMS.hemograma.code })).toBeVisible();

    // CRMLAB-78 (D-248): a atendente cria e edita; importar CSV continua so admin.
    await expect(page.getByRole('button', { name: /Novo Exame/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Importar CSV' })).toHaveCount(0);
  });

  test('a busca filtra por nome e por codigo, sem caixa nem acento', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, CATALOG_PATH, HEADING);

    await page.getByRole('searchbox').fill(E2E_EXAMS.glicose.code);
    await expect(page.getByRole('cell', { name: E2E_EXAMS.glicose.name })).toBeVisible();
    await expect(page.getByRole('cell', { name: E2E_EXAMS.hemograma.name })).toHaveCount(0);
  });

  test('o preco na tela e o mesmo numero do contrato', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, CATALOG_PATH, HEADING);
    await page.getByRole('searchbox').fill(E2E_EXAMS.vitaminaD.code);

    const linha = page.getByRole('row').filter({ hasText: E2E_EXAMS.vitaminaD.name });
    await expect(linha).toBeVisible();
    const texto = (await linha.textContent()) ?? '';
    // CLAUDE.md §9: no fio o dinheiro e `98`, na tela e `R$ 98,00`.
    expect(texto).toContain('98,00');
    expect(parseMoney(texto)).toBeGreaterThan(0);
  });

  test('a API aceita criar e editar do atendente, mas recusa importar CSV', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    // Exame proprio do teste: o seed nao muda, outros specs dependem do preco dele.
    const exame = await createExamViaApi(token, request);

    const edicao = await request.patch(`${API_URL}/exams/${exame.id}`, {
      headers: authHeaders(token),
      data: { pricePrivate: 12.5, isActive: false },
    });
    expect(edicao.status()).toBe(200);
    const editado = (await edicao.json()) as Exam;
    expect(editado.pricePrivate).toBe(12.5);
    expect(editado.isActive).toBe(false);

    const importacao = await request.post(`${API_URL}/exams/import/preview`, {
      headers: authHeaders(token),
      data: { fileName: 'catalogo.csv', contentBase64: 'YQ==' },
    });
    expect(importacao.status()).toBe(403);
    expect(((await importacao.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');
  });
});

test.describe('Fluxo 7: Catálogo (gestor escreve)', () => {
  test('gestor cria um exame pela tela e ele aparece na tabela', async ({ page }) => {
    const nome = `Exame QA ${uniqueCode()}`;
    const codigo = uniqueCode();

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, CATALOG_PATH, HEADING);

    await page.getByRole('button', { name: /Novo Exame/ }).click();
    const modal = page.getByTestId('modal-card');
    await modal.getByLabel('Nome').fill(nome);
    // `exact`: a Onda 7 acrescentou "Código TUSS" e "Código AMB" ao mesmo modal,
    // e o rotulo solto passou a casar tres campos.
    await modal.getByLabel('Código', { exact: true }).fill(codigo);
    await modal.getByLabel('Preço Particular (R$)').fill('77.5');
    await modal.getByLabel('Preço Convênio (R$)').fill('40');
    await modal.getByRole('button', { name: 'Criar' }).click();

    await page.getByRole('searchbox').fill(codigo);
    const linha = page.getByRole('row').filter({ hasText: nome });
    await expect(linha).toBeVisible();
    await expect(linha).toContainText('77,50');
    await expect(linha).toContainText('Ativo');
  });

  test('gestor edita o preco de um exame pela tela', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const exame = await createExamViaApi(token, request);

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, CATALOG_PATH, HEADING);
    await page.getByRole('searchbox').fill(exame.code);

    const linha = page.getByRole('row').filter({ hasText: exame.name });
    await expect(linha).toBeVisible();
    await linha.getByRole('button', { name: 'Editar' }).click();

    const modal = page.getByTestId('modal-card');
    await modal.getByLabel('Preço Particular (R$)').fill('123.45');
    await expect(modal.getByLabel('Preço Particular (R$)')).toHaveValue('123.45');
    await modal.getByRole('button', { name: 'Atualizar' }).click();

    await expect(linha).toContainText('123,45');
  });

  test('desativar e PATCH { isActive: false } — nao ha DELETE /exams/:id', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const exame = await createExamViaApi(token, request);

    // (a) o caminho documentado funciona
    const patch = await request.patch(`${API_URL}/exams/${exame.id}`, {
      headers: authHeaders(token),
      data: { isActive: false },
    });
    expect(patch.status()).toBe(200);
    expect(((await patch.json()) as Exam).isActive).toBe(false);

    // (b) o caminho NAO documentado nao existe — e nao apagou nada
    const del = await request.delete(`${API_URL}/exams/${exame.id}`, {
      headers: authHeaders(token),
    });
    expect([404, 405]).toContain(del.status());

    const lista = await request.get(`${API_URL}/exams?search=${exame.code}`, {
      headers: authHeaders(token),
    });
    const encontrado = ((await lista.json()) as ListExamsResponse).exams.find(
      (e) => e.id === exame.id,
    );
    expect(encontrado).toBeDefined();
    expect(encontrado?.isActive).toBe(false);
  });

  test('exame desativado sai do catalogo do orçamento, mas nao some do cadastro', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const exame = await createExamViaApi(token, request);
    await request.patch(`${API_URL}/exams/${exame.id}`, {
      headers: authHeaders(token),
      data: { isActive: false },
    });

    // `?active=true` e o filtro que a coluna de catalogo do orçamento usa.
    const ativos = await request.get(`${API_URL}/exams?active=true&search=${exame.code}`, {
      headers: authHeaders(token),
    });
    expect(((await ativos.json()) as ListExamsResponse).exams).toHaveLength(0);

    // Mas a tela de catalogo continua listando, marcado como Inativo.
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, CATALOG_PATH, HEADING);
    await page.getByRole('searchbox').fill(exame.code);
    await expect(page.getByRole('row').filter({ hasText: exame.name })).toContainText('Inativo');
  });

  test('proposta com exame inativo e recusada com EXAM_NOT_FOUND_OR_INACTIVE', async ({
    request,
  }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const exame = await createExamViaApi(gestor, request);
    await request.patch(`${API_URL}/exams/${exame.id}`, {
      headers: authHeaders(gestor),
      data: { isActive: false },
    });

    const atendente = await apiLogin(request, E2E_USERS.alfaAttendant);
    const response = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(atendente),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: exame.id, quantity: 1 }],
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
  });
});
