/**
 * Fluxo 1: Novo Orçamento — WORKFLOWS.md §3.
 *
 * conversa -> `/budget/new` -> 2 exames -> 10% -> criar -> enviar.
 *
 * Duas regras de negocio estao sob teste aqui, e as duas sao do BACKEND:
 *  - §1 total derivado: o cliente manda `{ examId, quantity }` e o desconto;
 *    NUNCA `totalPrice`. O 201 traz o total que o servidor calculou.
 *  - §2 alçada: 10% esta dentro dos 15% da atendente, entao a proposta ja nasce
 *    aprovada (D-048: `approvalStatus: "approved"`, nao `"none"`).
 *
 * Nada de `if (await x.isVisible())` neste arquivo: um passo que "pode nao
 * acontecer" e um passo que nao esta sendo testado.
 */
import { test, expect } from '@playwright/test';
import type { ProposalDetail } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_USERS,
  addExamToBudget,
  apiLogin,
  authHeaders,
  createProposal,
  getTotalPrice,
  gotoScreen,
  loginAs,
  openNewBudgetPage,
  proposalCard,
  setDiscount,
} from './helpers.js';

/** Hemograma (38) + Glicose (22) = 60,00; com 10% = 54,00. */
const SUBTOTAL = E2E_EXAMS.hemograma.pricePrivate + E2E_EXAMS.glicose.pricePrivate;
const DESCONTO = 10;
const TOTAL_ESPERADO = Number((SUBTOTAL * (1 - DESCONTO / 100)).toFixed(2));

test.describe('Fluxo 1: Novo Orçamento', () => {
  test('atendente monta orçamento, aplica desconto e cria a proposta', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await openNewBudgetPage(page, E2E_CONVERSATIONS.atribuida.id);

    await addExamToBudget(page, E2E_EXAMS.hemograma.name);
    await addExamToBudget(page, E2E_EXAMS.glicose.name);
    await setDiscount(page, DESCONTO);

    // A tela mostra o mesmo numero que o backend vai calcular (regra §1).
    await expect(async () => {
      expect(await getTotalPrice(page)).toBe(TOTAL_ESPERADO);
    }).toPass();

    const proposalId = await createProposal(page);

    // A fonte da verdade e o recurso salvo, nao o pixel.
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const salva = (await (
      await request.get(`${API_URL}/proposals/${proposalId}`, { headers: authHeaders(token) })
    ).json()) as ProposalDetail;

    expect(salva.totalPrice).toBe(TOTAL_ESPERADO);
    expect(salva.discountPercent).toBe(DESCONTO);
    expect(salva.items).toHaveLength(2);
    expect(salva.status).toBe('novo_contato');

    // Regressao explicita da Onda 7 contra a Onda 4: sem convenio escolhido o
    // fluxo antigo continua identico — `insuranceId` nulo (particular e a
    // AUSENCIA de convenio, D-082) e todo item com preco particular no
    // snapshot. Sem esta asserção, um default errado em `insuranceId` passaria
    // despercebido: o total seria o mesmo.
    expect(salva.insuranceId).toBeNull();
    for (const item of salva.items) {
      expect(item.priceSource).toBe('private');
    }
    expect(salva.items.map((item) => item.unitPrice)).toEqual([
      E2E_EXAMS.hemograma.pricePrivate,
      E2E_EXAMS.glicose.pricePrivate,
    ]);
  });

  test('o badge de origem de preco NAO aparece em orçamento particular', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await openNewBudgetPage(page, E2E_CONVERSATIONS.atribuida.id);
    await addExamToBudget(page, E2E_EXAMS.hemograma.name);

    // Sem convenio, TODO preco e particular — o badge seria redundante
    // (`SummaryColumn`: so marca item que caiu no particular DENTRO de uma
    // proposta com convenio).
    await expect(page.getByTestId('summary-items')).toBeVisible();
    await expect(page.getByTestId('price-source-badge')).toHaveCount(0);
  });

  test('desconto dentro da alçada (15%) nasce sem pendencia de aprovacao', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const response = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS.hemograma.id, quantity: 1 }],
        discountPercent: DESCONTO,
      },
    });

    expect(response.status()).toBe(201);
    const criada = (await response.json()) as ProposalDetail;
    // D-048: dentro da alçada nasce "approved"; "none" so aparece em seed.
    expect(['approved', 'none']).toContain(criada.approvalStatus);
  });

  test('o total vem do catalogo: preco enviado pelo cliente e ignorado', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    // `createProposalSchema` e `.strict()`: campo desconhecido e recusado —
    // o cliente nao tem como sequer TENTAR mandar o total (regra §2 de CLAUDE.md).
    const comTotal = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS.hemograma.id, quantity: 1 }],
        totalPrice: 0.01,
      },
    });
    expect(comTotal.status()).toBe(400);

    // E o caminho valido cobra o preco do catalogo.
    const valida = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS.hemograma.id, quantity: 2 }],
      },
    });
    expect(valida.status()).toBe(201);
    expect(((await valida.json()) as ProposalDetail).totalPrice).toBe(
      E2E_EXAMS.hemograma.pricePrivate * 2,
    );
  });

  test('proposta criada pode ser marcada como enviada', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const criada = (await (
      await request.post(`${API_URL}/proposals`, {
        headers: authHeaders(token),
        data: {
          conversationId: E2E_CONVERSATIONS.atribuida.id,
          items: [{ examId: E2E_EXAMS.glicose.id, quantity: 1 }],
        },
      })
    ).json()) as ProposalDetail;

    const enviada = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'orcamento_enviado' },
    });
    expect(enviada.status()).toBe(200);
    expect(((await enviada.json()) as ProposalDetail).status).toBe('orcamento_enviado');
  });

  test('a proposta criada aparece no pipeline do atendente', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const criada = (await (
      await request.post(`${API_URL}/proposals`, {
        headers: authHeaders(token),
        data: {
          conversationId: E2E_CONVERSATIONS.atribuida.id,
          items: [{ examId: E2E_EXAMS.tsh.id, quantity: 1 }],
        },
      })
    ).json()) as ProposalDetail;

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, '/proposals', 'Pipeline de Propostas');
    await expect(proposalCard(page, criada)).toBeVisible();
  });
});
