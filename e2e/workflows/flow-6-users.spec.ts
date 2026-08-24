/**
 * Fluxo 6: Usuários & Permissões — PAGES.md §10, SERVICES.md §10.
 *
 * O que este spec prova:
 *  - admin cria usuario, altera papel + alçada e desativa, tudo pela tela;
 *  - a alçada e do BACKEND: o usuario recem-criado com limite 10% recebe
 *    `approvalStatus: "pending"` ao pedir 25% (D-045: e 201, nao 403);
 *  - cada alteracao de permissao gera audit log (CLAUDE.md §7);
 *  - atendente e gestor NAO alcançam `/settings/users` — nem a tela, nem a API.
 *
 * O e-mail do usuario criado carrega um sufixo de tempo: a suite pode rodar
 * varias vezes sobre o MESMO banco semeado sem colidir em `CONFLICT`.
 */
import { test, expect } from '@playwright/test';
import type { ListAuditResponse, ListUsersResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_TENANTS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  type ApiErrorEnvelope,
} from './helpers.js';

const USERS_PATH = '/settings/users';
const HEADING = 'Usuários & Permissões';

/** Senha do usuario criado no teste (>= 8 caracteres, exigencia do backend). */
const NEW_USER_PASSWORD = 'Qa#Senha2026';

function uniqueEmail(): string {
  return `qa-${Date.now()}@${E2E_TENANTS.alfa.slug}.test`;
}

test.describe('Fluxo 6: Usuários & Permissões (admin)', () => {
  test('admin cria usuario, troca papel/alçada e desativa', async ({ page }) => {
    const email = uniqueEmail();
    const nome = 'Usuária Criada no E2E';

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, USERS_PATH, HEADING);

    // ── criar ───────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: /Novo Usuário/ }).click();
    const modal = page.getByTestId('modal-card');
    await expect(modal.getByText('Novo Usuário')).toBeVisible();

    await modal.getByLabel('Email').fill(email);
    await modal.getByLabel('Nome').fill(nome);
    await modal.getByLabel('Senha').fill(NEW_USER_PASSWORD);
    await modal.getByLabel('Função').selectOption('manager');
    // A alçada nao tem `<label for>`; o campo e o unico numerico do modal.
    await modal.getByRole('spinbutton').fill('20');
    await modal.getByRole('button', { name: 'Criar Usuário' }).click();

    const linha = page.getByRole('row').filter({ hasText: email });
    await expect(linha).toBeVisible();
    await expect(linha).toContainText('Gestor');
    await expect(linha).toContainText('20%');
    await expect(linha).toContainText('Ativo');

    // ── trocar papel e alçada ──────────────────────────────────────────────
    await linha.getByRole('button', { name: 'Editar' }).click();
    const edicao = page.getByTestId('modal-card');
    await expect(edicao.getByText('Editar Usuário')).toBeVisible();
    // E-mail e imutavel na edicao (o backend nem aceita o campo).
    await expect(edicao.getByLabel('Email')).toBeDisabled();

    await edicao.getByLabel('Função').selectOption('attendant');
    await edicao.getByRole('spinbutton').fill('10');
    // Conferir o formulario ANTES de salvar: se o modal recarregar a lista e
    // reescrever o estado, a falha aponta para o clobber, nao para o PATCH.
    await expect(edicao.getByLabel('Função')).toHaveValue('attendant');
    await expect(edicao.getByRole('spinbutton')).toHaveValue('10');
    await edicao.getByRole('button', { name: 'Salvar Alterações' }).click();

    await expect(linha).toContainText('Atendente');
    await expect(linha).toContainText('10%');

    // ── desativar ──────────────────────────────────────────────────────────
    await linha.getByRole('button', { name: 'Editar' }).click();
    const desativacao = page.getByTestId('modal-card');
    await desativacao.getByRole('switch').click();
    await expect(desativacao.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await desativacao.getByRole('button', { name: 'Salvar Alterações' }).click();

    await expect(linha).toContainText('Inativo');
  });

  test('a alçada definida pelo admin vale no BACKEND, nao so na tela', async ({ request }) => {
    const email = uniqueEmail();
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);

    const criado = await request.post(`${API_URL}/users`, {
      headers: authHeaders(admin),
      data: {
        email,
        name: 'Atendente de Alçada Curta',
        password: NEW_USER_PASSWORD,
        role: 'attendant',
        discountLimit: 10,
      },
    });
    expect(criado.status()).toBe(201);

    // Login do novo usuario e proposta com desconto ACIMA da alçada dele.
    const token = await apiLogin(request, {
      ...E2E_USERS.alfaAttendant,
      email,
      password: NEW_USER_PASSWORD,
    });
    const proposta = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS.hemograma.id, quantity: 1 }],
        discountPercent: 25,
      },
    });

    // D-045: acima da alçada NAO e 403 — e 201 com aprovacao pendente.
    expect(proposta.status()).toBe(201);
    const corpo = (await proposta.json()) as { approvalStatus: string };
    expect(corpo.approvalStatus).toBe('pending');
  });

  test('criar e editar usuario deixam rastro no log de auditoria', async ({ page, request }) => {
    const email = uniqueEmail();
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);

    const criado = await request.post(`${API_URL}/users`, {
      headers: authHeaders(admin),
      data: { email, name: 'Auditada', password: NEW_USER_PASSWORD, role: 'attendant' },
    });
    expect(criado.status()).toBe(201);
    const { id } = (await criado.json()) as { id: string };

    await request.patch(`${API_URL}/users/${id}`, {
      headers: authHeaders(admin),
      data: { discountLimit: 5 },
    });

    // CLAUDE.md §7: permissao gera audit log.
    const auditoria = await request.get(`${API_URL}/audit?entityId=${id}`, {
      headers: authHeaders(admin),
    });
    expect(auditoria.status()).toBe(200);
    const entries = ((await auditoria.json()) as ListAuditResponse).entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // E a aba "Log de Auditoria" da tela mostra o que a API devolveu.
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, USERS_PATH, HEADING);
    await page.getByRole('tab', { name: 'Log de Auditoria' }).click();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('e-mail repetido devolve CONFLICT e nao cria um segundo usuario', async ({ request }) => {
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const response = await request.post(`${API_URL}/users`, {
      headers: authHeaders(admin),
      data: {
        email: E2E_USERS.alfaManager.email,
        name: 'Sósia do Gestor',
        password: NEW_USER_PASSWORD,
        role: 'manager',
      },
    });

    expect(response.status()).toBe(409);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error.code).toBe('CONFLICT');
  });
});

test.describe('Fluxo 6: guarda de papel', () => {
  test('atendente nao alcança /settings/users', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(USERS_PATH);

    await expect(page).toHaveURL(/\/attendance$/);
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toHaveCount(0);
  });

  test('gestor tambem nao alcança /settings/users (a tela e admin-only)', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await page.goto(USERS_PATH);

    await expect(page).toHaveURL(/\/proposals$/);
    await expect(page.getByRole('heading', { level: 1, name: HEADING })).toHaveCount(0);
  });

  test('a API recusa o atendente mesmo sem passar pela tela', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    for (const call of [
      request.get(`${API_URL}/users`, { headers: authHeaders(token) }),
      request.post(`${API_URL}/users`, {
        headers: authHeaders(token),
        data: {
          email: uniqueEmail(),
          name: 'Escalada de Privilegio',
          password: NEW_USER_PASSWORD,
          role: 'admin',
        },
      }),
      request.patch(`${API_URL}/users/${E2E_USERS.alfaAttendant.id}`, {
        headers: authHeaders(token),
        data: { role: 'admin', discountLimit: 100 },
      }),
      request.get(`${API_URL}/audit`, { headers: authHeaders(token) }),
    ]) {
      const response = await call;
      expect(response.status()).toBe(403);
      expect(((await response.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');
    }

    // A alçada do atendente continua a do seed — nada foi escalado.
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const lista = await request.get(
      `${API_URL}/users?search=${encodeURIComponent(E2E_USERS.alfaAttendant.email)}`,
      { headers: authHeaders(admin) },
    );
    const users = ((await lista.json()) as ListUsersResponse).users;
    const alvo = users.find((u) => u.id === E2E_USERS.alfaAttendant.id);
    expect(alvo?.role).toBe('attendant');
    expect(alvo?.discountLimit).toBe(E2E_USERS.alfaAttendant.discountLimit);
  });
});
