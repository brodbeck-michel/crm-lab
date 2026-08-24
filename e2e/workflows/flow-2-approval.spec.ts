/**
 * Fluxo 2: Aprovação de Desconto — WORKFLOWS.md §4, BUSINESS_RULES §2.
 *
 * Atendente (alçada 15%) pede 25% -> a proposta NASCE com
 * `approvalStatus: "pending"` e **201**, nao 403 (D-045) -> o pedido e postado
 * em `#aprovacoes` com o texto de `E2E_APPROVAL_POST` -> o GESTOR aprova ->
 * so entao a proposta pode ser enviada.
 *
 * Dois usuarios distintos, sempre: aprovar a propria proposta falha por
 * projeto (D-046), entao um spec que usasse um usuario so estaria testando o
 * caminho errado.
 *
 * LIMITE DE AMBIENTE, dito com todas as letras: `/internal-chat` ainda e
 * `InternalChatPlaceholder` em `frontend/src/routes/index.tsx`. O cartao com
 * [Aprovar] / [Rejeitar] nao existe na tela, entao a metade "gestor clica em
 * Aprovar no canal" e verificada pelo CONTRATO (`PATCH /proposals/:id/approve`
 * + conteudo de `#aprovacoes` via API), nao por clique. Quando a tela existir,
 * o teste de clique entra aqui — e nao ha `test.skip` escondendo isso.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type {
  Channel,
  ListChannelsResponse,
  ListInternalMessagesResponse,
  ProposalDetail,
} from '@crm-lab/shared';
import {
  API_URL,
  E2E_APPROVAL_POST,
  E2E_CHANNELS,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_PROPOSALS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  discountField,
  gotoScreen,
  loginAs,
  proposalCard,
  type ApiErrorEnvelope,
} from './helpers.js';

const PIPELINE_HEADING = 'Pipeline de Propostas';

/** Cria uma proposta de 25% (acima da alçada da atendente) e devolve o detalhe. */
async function criarPendente(
  request: APIRequestContext,
): Promise<ProposalDetail> {
  const token = await apiLogin(request, E2E_USERS.alfaAttendant);
  const response = await request.post(`${API_URL}/proposals`, {
    headers: authHeaders(token),
    data: {
      conversationId: E2E_CONVERSATIONS.aprovacao.id,
      items: [
        { examId: E2E_EXAMS.vitaminaD.id, quantity: 1 },
        { examId: E2E_EXAMS.tsh.id, quantity: 1 },
        { examId: E2E_EXAMS.hemograma.id, quantity: 1 },
      ],
      discountPercent: E2E_PROPOSALS.pendenteAprovacao.discountPercent,
    },
  });
  // D-045: acima da alçada e 201 com pendencia, nunca 403.
  expect(response.status()).toBe(201);
  return (await response.json()) as ProposalDetail;
}

test.describe('Fluxo 2: Aprovação de Desconto', () => {
  test('desconto acima da alçada nasce pendente, com o total do catalogo', async ({ request }) => {
    const criada = await criarPendente(request);

    expect(criada.approvalStatus).toBe('pending');
    // 98 + 48 + 38 = 184,00 - 25% = 138,00 (o mesmo total do seed).
    expect(criada.totalPrice).toBe(E2E_PROPOSALS.pendenteAprovacao.expectedTotal);
  });

  test('proposta pendente nao pode ser enviada ao paciente', async ({ request }) => {
    const criada = await criarPendente(request);
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    const envio = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'orcamento_enviado' },
    });

    expect(envio.status()).toBe(409);
    const body = (await envio.json()) as ApiErrorEnvelope;
    expect(body.error.code).toBe('PROPOSAL_PENDING_APPROVAL');
    expect(body.error.details?.approvalStatus).toBe('pending');
  });

  test('o autor NAO aprova a propria proposta', async ({ request }) => {
    const criada = await criarPendente(request);
    const autor = await apiLogin(request, E2E_USERS.alfaAttendant);

    const tentativa = await request.patch(`${API_URL}/proposals/${criada.id}/approve`, {
      headers: authHeaders(autor),
    });

    // Atendente nem tem o papel; e mesmo com papel, D-046 barra o autor.
    expect(tentativa.status()).toBe(403);
    expect(((await tentativa.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');
  });

  test('o gestor aprova e a proposta passa a poder ser enviada', async ({ request }) => {
    const criada = await criarPendente(request);

    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const aprovacao = await request.patch(`${API_URL}/proposals/${criada.id}/approve`, {
      headers: authHeaders(gestor),
    });
    expect(aprovacao.status()).toBe(200);

    const atendente = await apiLogin(request, E2E_USERS.alfaAttendant);
    const depois = (await (
      await request.get(`${API_URL}/proposals/${criada.id}`, { headers: authHeaders(atendente) })
    ).json()) as ProposalDetail;
    expect(depois.approvalStatus).toBe('approved');

    const envio = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(atendente),
      data: { status: 'orcamento_enviado' },
    });
    expect(envio.status()).toBe(200);
  });

  test('rejeicao exige motivo e bloqueia o envio', async ({ request }) => {
    const criada = await criarPendente(request);
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);

    const semMotivo = await request.patch(`${API_URL}/proposals/${criada.id}/reject`, {
      headers: authHeaders(gestor),
      data: {},
    });
    expect(semMotivo.status()).toBe(400);

    const comMotivo = await request.patch(`${API_URL}/proposals/${criada.id}/reject`, {
      headers: authHeaders(gestor),
      data: { reason: 'Margem insuficiente para este desconto.' },
    });
    expect(comMotivo.status()).toBe(200);

    // D-047: rejeitada tambem nao vai para `orcamento_enviado`.
    const atendente = await apiLogin(request, E2E_USERS.alfaAttendant);
    const envio = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(atendente),
      data: { status: 'orcamento_enviado' },
    });
    expect(envio.status()).toBe(409);
    expect(((await envio.json()) as ApiErrorEnvelope).error.code).toBe('PROPOSAL_PENDING_APPROVAL');
  });

  test('o pedido aparece em #aprovacoes com o texto do contrato', async ({ request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const headers = authHeaders(gestor);

    const canais = ((await (
      await request.get(`${API_URL}/internal-chat/channels`, { headers })
    ).json()) as ListChannelsResponse).channels;

    const aprovacoes: Channel | undefined = canais.find(
      (c) => c.key === E2E_CHANNELS.aprovacoes.key,
    );
    expect(aprovacoes, `canal ${E2E_CHANNELS.aprovacoes.name} deve existir`).toBeDefined();

    const mensagens = ((await (
      await request.get(`${API_URL}/internal-chat/channels/${aprovacoes?.id}/messages?limit=100`, {
        headers,
      })
    ).json()) as ListInternalMessagesResponse).messages;

    // Texto exato acordado com o Agent-DB-Seeds (`E2E_APPROVAL_POST`).
    expect(mensagens.map((m) => m.content)).toContain(E2E_APPROVAL_POST);
  });
});

test.describe('Fluxo 2: o que a tela mostra hoje', () => {
  // A proposta e criada pelo teste, nao lida do seed: `/proposals` carrega
  // apenas a PRIMEIRA pagina (limite 20, sem paginacao na tela), entao um
  // cartao semeado deixa de ser alcancavel assim que o laboratorio passa de 20
  // propostas. O cartao recem-criado e sempre o mais novo.
  test('o cartao da proposta pendente avisa que aguarda aprovacao', async ({ page, request }) => {
    const criada = await criarPendente(request);

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, '/proposals', PIPELINE_HEADING);

    const cartao = proposalCard(page, criada.id);
    await expect(cartao).toBeVisible();
    await expect(cartao).toContainText('Aguardando aprovação');
  });

  test('o modal da proposta pendente mostra o alerta de aprovacao', async ({ page, request }) => {
    const criada = await criarPendente(request);

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, '/proposals', PIPELINE_HEADING);

    await proposalCard(page, criada.id).click();
    const modal = page.getByTestId('modal-card');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Aguardando aprovação do gestor')).toBeVisible();
  });

  test('o atendente ve o aviso de aprovacao ao passar da alçada no orçamento', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(`/budget/new?conversationId=${E2E_CONVERSATIONS.aprovacao.id}`);
    await expect(page.getByTestId('budget-catalog')).toBeVisible();

    const resumo = page.getByTestId('budget-summary');
    await page
      .getByTestId('budget-catalog')
      .getByRole('button', { name: new RegExp(E2E_EXAMS.vitaminaD.name) })
      .click();
    await discountField(page).fill('25');

    // "A UI esconde, o servidor recusa": o aviso e UX; a regra e do backend.
    await expect(resumo.getByText('Exigirá aprovação do gestor')).toBeVisible();
  });
});
