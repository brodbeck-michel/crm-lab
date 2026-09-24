/**
 * Fluxo Isolamento — o cenario "Isolamento" de docs/guides/TESTING.md:
 * "usuário do tenant A não vê NADA do tenant B".
 *
 * O seed e2e monta os dois lados de proposito (ver `e2e-fixtures.ts`):
 * `E2E_TENANTS.alfa` e `E2E_TENANTS.beta`, com `E2E_CONVERSATIONS.betaSecreta`
 * e `E2E_PROPOSALS.betaSecreta` marcadas como "nada disto pode aparecer".
 *
 * O spec ataca por dois lados, porque um so nao basta:
 *
 *  - **pela TELA**: nenhum nome/valor de Beta aparece em nenhuma tela de Alfa,
 *    nem quando o id de Beta e colado direto na URL;
 *  - **pelo CONTRATO**: id de Beta em rota de Alfa devolve 404 `NOT_FOUND`.
 *    `FORBIDDEN` seria um vazamento — confirmaria que o recurso existe
 *    (CLAUDE.md §8 / API_ERRORS.md).
 *
 * A varredura EXAUSTIVA de rotas (incluindo `platform_operator`, que nao existe
 * no seed e2e) vive em `backend/tests/kernel/route-tenant-isolation.spec.ts`,
 * onde os dois tenants sao construidos do zero em PGlite.
 */
import { test, expect } from '@playwright/test';
import type { ListExamsResponse, ListProposalsResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_EXAMS_BETA,
  E2E_PROPOSALS,
  E2E_TENANTS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  expectAbsent,
  expectNotFound,
  gotoScreen,
  loginAs,
  logout,
  type ApiErrorEnvelope,
} from './helpers.js';

/** Tudo que so existe no tenant Beta. Nada disto pode vazar para Alfa. */
const SEGREDOS_DE_BETA = [
  E2E_CONVERSATIONS.betaSecreta.patientName,
  E2E_CONVERSATIONS.betaSecreta.patientPhone,
  E2E_TENANTS.beta.name,
] as const;

test.describe('Isolamento: pelo contrato (id de outro tenant -> 404)', () => {
  test('usuario de Alfa nao alcança conversa, proposta nem usuario de Beta', async ({ request }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAdmin);

    await expectNotFound(request, alfa, `/conversations/${E2E_CONVERSATIONS.betaSecreta.id}`);
    await expectNotFound(request, alfa, `/proposals/${E2E_PROPOSALS.betaSecreta.id}`);
  });

  test('usuario de Beta nao alcança conversa nem proposta de Alfa (simetrico)', async ({
    request,
  }) => {
    const beta = await apiLogin(request, E2E_USERS.betaAttendant);

    await expectNotFound(request, beta, `/conversations/${E2E_CONVERSATIONS.aprovacao.id}`);
    await expectNotFound(request, beta, `/proposals/${E2E_PROPOSALS.pendenteAprovacao.id}`);
  });

  test('ESCRITA em recurso de Beta tambem devolve 404, e nao altera nada', async ({ request }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAdmin);
    const headers = authHeaders(alfa);

    const encerrar = await request.patch(
      `${API_URL}/conversations/${E2E_CONVERSATIONS.betaSecreta.id}`,
      { headers, data: { status: 'closed' } },
    );
    expect(encerrar.status()).toBe(404);
    expect(((await encerrar.json()) as ApiErrorEnvelope).error.code).toBe('NOT_FOUND');

    const mensagem = await request.post(
      `${API_URL}/conversations/${E2E_CONVERSATIONS.betaSecreta.id}/messages`,
      { headers, data: { content: 'mensagem indevida' } },
    );
    expect(mensagem.status()).toBe(404);

    const mover = await request.patch(
      `${API_URL}/proposals/${E2E_PROPOSALS.betaSecreta.id}/status`,
      { headers, data: { status: 'perdido', reasonLost: 'preco' } },
    );
    expect(mover.status()).toBe(404);

    const editarExame = await request.patch(`${API_URL}/exams/${E2E_EXAMS_BETA.hemograma.id}`, {
      headers,
      data: { isActive: false, pricePrivate: 1 },
    });
    expect(editarExame.status()).toBe(404);

    // O outro lado confirma que nada mudou de fato.
    const beta = await apiLogin(request, E2E_USERS.betaAttendant);
    const exames = await request.get(
      `${API_URL}/exams?search=${E2E_EXAMS_BETA.hemograma.code}`,
      { headers: authHeaders(beta) },
    );
    const alvo = ((await exames.json()) as ListExamsResponse).exams.find(
      (e) => e.id === E2E_EXAMS_BETA.hemograma.id,
    );
    expect(alvo?.isActive).toBe(true);
    expect(alvo?.pricePrivate).toBe(E2E_EXAMS_BETA.hemograma.pricePrivate);
  });

  test('criar proposta apontando para a conversa de Beta devolve 404', async ({ request }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAttendant);
    const response = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(alfa),
      data: {
        conversationId: E2E_CONVERSATIONS.betaSecreta.id,
        items: [{ examId: E2E_EXAMS.hemograma.id, quantity: 1 }],
      },
    });

    expect(response.status()).toBe(404);
    expect(((await response.json()) as ApiErrorEnvelope).error.code).toBe('NOT_FOUND');
  });

  test('usar o exame de Beta num orçamento de Alfa nao vaza o preco do outro lab', async ({
    request,
  }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAttendant);
    const response = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(alfa),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS_BETA.hemograma.id, quantity: 1 }],
      },
    });

    // Exame de outro tenant e indistinguivel de um inexistente.
    expect(response.status()).toBe(400);
    const corpo = (await response.json()) as ApiErrorEnvelope;
    expect(corpo.error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
    expect(JSON.stringify(corpo)).not.toContain(String(E2E_EXAMS_BETA.hemograma.pricePrivate));
    expect(JSON.stringify(corpo)).not.toContain(E2E_EXAMS_BETA.hemograma.name);
  });

  test('listagens e filtros nunca cruzam o tenant', async ({ request }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAdmin);
    const headers = authHeaders(alfa);

    const propostas = await request.get(`${API_URL}/proposals?limit=100`, { headers });
    const ids = ((await propostas.json()) as ListProposalsResponse).proposals.map((p) => p.id);
    expect(ids).not.toContain(E2E_PROPOSALS.betaSecreta.id);

    // Filtrar explicitamente pelo id de Beta volta VAZIO — nunca 403.
    const filtrada = await request.get(
      `${API_URL}/proposals?conversationId=${E2E_CONVERSATIONS.betaSecreta.id}`,
      { headers },
    );
    expect(filtrada.status()).toBe(200);
    expect(((await filtrada.json()) as ListProposalsResponse).proposals).toHaveLength(0);

    // Buscar o exame de Beta pelo codigo devolve o exame HOMONIMO de Alfa,
    // com o preco de Alfa — nunca o de Beta.
    const exames = await request.get(
      `${API_URL}/exams?search=${E2E_EXAMS_BETA.hemograma.code}`,
      { headers },
    );
    const encontrados = ((await exames.json()) as ListExamsResponse).exams;
    expect(encontrados.map((e) => e.id)).not.toContain(E2E_EXAMS_BETA.hemograma.id);
    for (const exam of encontrados) {
      expect(exam.pricePrivate).not.toBe(E2E_EXAMS_BETA.hemograma.pricePrivate);
    }
  });

  test('token de Alfa nao vira token de Beta trocando header ou query', async ({ request }) => {
    const alfa = await apiLogin(request, E2E_USERS.alfaAdmin);

    // O `tenantId` sai SEMPRE da claim assinada (middleware `requireAuth`);
    // header e query do cliente sao ignorados de proposito.
    const forjado = await request.get(
      `${API_URL}/conversations/${E2E_CONVERSATIONS.betaSecreta.id}?tenantId=${E2E_TENANTS.beta.id}`,
      { headers: { ...authHeaders(alfa), 'X-Tenant-Id': E2E_TENANTS.beta.id } },
    );
    expect(forjado.status()).toBe(404);
  });
});

test.describe('Isolamento: pela tela', () => {
  test('nenhuma tela de Alfa mostra dado de Beta', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);

    const telas: ReadonlyArray<readonly [string, string]> = [
      ['/proposals', 'Pipeline de Propostas'],
      ['/catalog', 'Catálogo de Exames'],
      ['/analytics', 'Conversão'],
      ['/settings/users', 'Usuários & Permissões'],
    ];

    for (const [path, heading] of telas) {
      await gotoScreen(page, path, heading);
      for (const segredo of SEGREDOS_DE_BETA) {
        await expectAbsent(page, segredo);
      }
      await expectAbsent(page, E2E_USERS.betaAttendant.email);
    }
  });

  test('o inbox do atendente de Alfa nao lista a conversa secreta de Beta', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await expect(page).toHaveURL(/\/attendance$/);

    // A conversa propria aparece...
    await expect(page.getByText(E2E_CONVERSATIONS.atribuida.patientName).first()).toBeVisible();
    // ...e a do outro laboratorio, nao.
    for (const segredo of SEGREDOS_DE_BETA) {
      await expectAbsent(page, segredo);
    }
  });

  test('colar o id de Beta na URL do orçamento nao cria nada nem mostra o paciente', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(`/budget/new?conversationId=${E2E_CONVERSATIONS.betaSecreta.id}`);

    // A tela abre (a rota e valida), mas o paciente de Beta nao aparece.
    await expect(page.getByTestId('budget-catalog')).toBeVisible();
    await expectAbsent(page, E2E_CONVERSATIONS.betaSecreta.patientName);

    // E a criacao morre no backend com 404 — o total nem chega a existir.
    const resposta = page.waitForResponse(
      (res) => res.url().includes('/proposals') && res.request().method() === 'POST',
    );
    await page
      .getByTestId('budget-catalog')
      .getByRole('button', { name: new RegExp(E2E_EXAMS.hemograma.name) })
      .click();
    await page.getByRole('button', { name: 'Criar Orçamento' }).click();

    const response = await resposta;
    expect(response.status()).toBe(404);
  });

  test('trocar de usuario nao carrega o tenant anterior', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await expect(page.getByText(E2E_CONVERSATIONS.atribuida.patientName).first()).toBeVisible();

    await logout(page);
    await loginAs(page, E2E_USERS.betaAttendant);

    // Agora o lado de la ve o que e dele...
    await expect(page.getByText(E2E_CONVERSATIONS.betaSecreta.patientName).first()).toBeVisible();
    // ...e nada do lado de ca.
    await expectAbsent(page, E2E_CONVERSATIONS.atribuida.patientName);
    await expectAbsent(page, E2E_CONVERSATIONS.aprovacao.patientName);
  });
});

test.describe('Isolamento: console da plataforma', () => {
  /**
   * A metade "operador nao entra no laboratorio" e varrida rota a rota em
   * `backend/tests/kernel/route-tenant-isolation.spec.ts`: o seed e2e nao cria
   * usuario `platform_operator`, entao nao ha como logar como um aqui.
   * O que da para provar por E2E e a metade inversa — e ela tambem e requisito.
   */
  test('usuario de laboratorio nao entra em /platform/*', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await page.goto('/platform/tenants');

    await expect(page).toHaveURL(/\/proposals$/);
    await expectAbsent(page, E2E_TENANTS.beta.name);
  });

  test('a API de plataforma recusa qualquer papel de laboratorio', async ({ request }) => {
    for (const user of [E2E_USERS.alfaAdmin, E2E_USERS.alfaManager, E2E_USERS.alfaAttendant]) {
      const token = await apiLogin(request, user);
      for (const path of ['/platform/tenants', '/platform/billing']) {
        const response = await request.get(`${API_URL}${path}`, { headers: authHeaders(token) });
        expect(response.status(), `${user.role} em ${path}`).toBe(403);
        const body = (await response.json()) as ApiErrorEnvelope;
        expect(body.error.code).toBe('FORBIDDEN');
        expect(body.error.details?.requiredRoles).toEqual(['platform_operator']);
      }
    }
  });
});
