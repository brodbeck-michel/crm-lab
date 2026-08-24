/**
 * Fluxo 3: Pipeline — ganho / perdido. WORKFLOWS.md §5, BUSINESS_RULES §3.
 *
 * O `ProposalModal` esta montado em `App.tsx`, entao este fluxo roda de ponta a
 * ponta pela TELA: clicar no cartao abre o modal, o modal muda o estagio.
 *
 * Regras sob teste:
 *  - so transicoes de `ALLOWED_TRANSITIONS`;
 *  - `perdido` EXIGE `reasonLost` valido — o botao Confirmar fica desabilitado
 *    ate o motivo ser escolhido, e o backend recusa quem burlar a tela;
 *  - `ganho`/`perdido` sao TERMINAIS: nada sai de la.
 *
 * Cada teste cria a sua propria proposta pela API. Estagio e caminho sem volta:
 * reaproveitar a proposta do seed faria o segundo `npm run e2e` falhar.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ProposalDetail } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_PROPOSALS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  proposalCard,
  type ApiErrorEnvelope,
} from './helpers.js';

const PIPELINE = '/proposals';
const HEADING = 'Pipeline de Propostas';

/** Cria uma proposta ja no estagio pedido, andando pelas transicoes validas. */
async function criarNoEstagio(
  request: APIRequestContext,
  estagios: readonly string[],
): Promise<ProposalDetail> {
  const token = await apiLogin(request, E2E_USERS.alfaAttendant);
  const criada = (await (
    await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.pipeline.id,
        items: [
          { examId: E2E_EXAMS.colesterol.id, quantity: 1 },
          { examId: E2E_EXAMS.triglicerides.id, quantity: 1 },
        ],
      },
    })
  ).json()) as ProposalDetail;

  let atual = criada;
  for (const status of estagios) {
    const response = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(token),
      data: { status },
    });
    expect(response.status(), `transicao para ${status}`).toBe(200);
    atual = (await response.json()) as ProposalDetail;
  }
  return atual;
}

test.describe('Fluxo 3: marcar como ganho', () => {
  test('atendente abre a proposta em negociacao e marca como ganho', async ({ page, request }) => {
    const proposta = await criarNoEstagio(request, [
      'orcamento_enviado',
      'follow_up',
      'negociacao',
    ]);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, PIPELINE, HEADING);

    await proposalCard(page, proposta.id).click();
    const modal = page.getByTestId('modal-card');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Marcar como Ganho' }).click();

    // Estagio terminal: os dois botoes de fechamento ficam indisponiveis.
    await expect(modal.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Marcar como Perdido' })).toBeDisabled();

    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const salva = (await (
      await request.get(`${API_URL}/proposals/${proposta.id}`, { headers: authHeaders(token) })
    ).json()) as ProposalDetail;
    expect(salva.status).toBe('ganho');
    expect(salva.closedAt).not.toBeNull();
  });
});

test.describe('Fluxo 3: marcar como perdido', () => {
  test('perdido exige motivo: Confirmar so libera depois da escolha', async ({ page, request }) => {
    const proposta = await criarNoEstagio(request, ['orcamento_enviado', 'follow_up']);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, PIPELINE, HEADING);

    await proposalCard(page, proposta.id).click();
    const modal = page.getByTestId('modal-card');
    await modal.getByRole('button', { name: 'Marcar como Perdido' }).click();

    const confirmar = modal.getByRole('button', { name: 'Confirmar' });
    await expect(confirmar).toBeDisabled();

    await modal.getByLabel('Motivo da Perda').selectOption(E2E_PROPOSALS.perdida.reasonLost ?? '');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const salva = (await (
      await request.get(`${API_URL}/proposals/${proposta.id}`, { headers: authHeaders(token) })
    ).json()) as ProposalDetail;
    expect(salva.status).toBe('perdido');
    expect(salva.reasonLost).toBe(E2E_PROPOSALS.perdida.reasonLost);
    expect(salva.closedAt).not.toBeNull();
  });

  test('o motivo persiste ao reabrir a proposta perdida', async ({ page, request }) => {
    const proposta = await criarNoEstagio(request, ['orcamento_enviado']);
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    await request.patch(`${API_URL}/proposals/${proposta.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'perdido', reasonLost: E2E_PROPOSALS.perdida.reasonLost },
    });

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, PIPELINE, HEADING);

    await proposalCard(page, proposta.id).click();
    const modal = page.getByTestId('modal-card');
    await expect(modal).toBeVisible();
    // Terminal: nao ha como sair de `perdido` pela tela.
    await expect(modal.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Marcar como Perdido' })).toBeDisabled();

    // E o motivo continua gravado no recurso.
    const salva = (await (
      await request.get(`${API_URL}/proposals/${proposta.id}`, { headers: authHeaders(token) })
    ).json()) as ProposalDetail;
    expect(salva.reasonLost).toBe(E2E_PROPOSALS.perdida.reasonLost);
  });

  test('o backend recusa `perdido` sem motivo, mesmo sem passar pela tela', async ({ request }) => {
    const proposta = await criarNoEstagio(request, ['orcamento_enviado']);
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    const semMotivo = await request.patch(`${API_URL}/proposals/${proposta.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'perdido' },
    });
    expect(semMotivo.status()).toBe(400);
    expect(((await semMotivo.json()) as ApiErrorEnvelope).error.code).toBe('LOSS_REASON_REQUIRED');

    const motivoInvalido = await request.patch(`${API_URL}/proposals/${proposta.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'perdido', reasonLost: 'porque_sim' },
    });
    expect(motivoInvalido.status()).toBe(400);
  });
});

test.describe('Fluxo 3: matriz de transicoes', () => {
  test('pular estagio e recusado (novo_contato -> ganho)', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const criada = (await (
      await request.post(`${API_URL}/proposals`, {
        headers: authHeaders(token),
        data: {
          conversationId: E2E_CONVERSATIONS.pipeline.id,
          items: [{ examId: E2E_EXAMS.psa.id, quantity: 1 }],
        },
      })
    ).json()) as ProposalDetail;
    expect(criada.status).toBe('novo_contato');

    const pulo = await request.patch(`${API_URL}/proposals/${criada.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'ganho' },
    });
    expect(pulo.status()).toBe(400);
    expect(((await pulo.json()) as ApiErrorEnvelope).error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  test('estagio terminal nao volta atras', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    const resposta = await request.patch(
      `${API_URL}/proposals/${E2E_PROPOSALS.ganha.id}/status`,
      { headers: authHeaders(token), data: { status: 'negociacao' } },
    );

    // Ja encerrada: 409 PROPOSAL_ALREADY_CLOSED ou 400 de transicao invalida —
    // o que nao pode e a proposta sair do terminal.
    expect([400, 409]).toContain(resposta.status());

    const depois = (await (
      await request.get(`${API_URL}/proposals/${E2E_PROPOSALS.ganha.id}`, {
        headers: authHeaders(token),
      })
    ).json()) as ProposalDetail;
    expect(depois.status).toBe('ganho');
  });

  test('o pipeline separa ganho e perdido em colunas diferentes', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const ganha = await criarNoEstagio(request, ['orcamento_enviado', 'follow_up', 'negociacao']);
    await request.patch(`${API_URL}/proposals/${ganha.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'ganho' },
    });
    const perdida = await criarNoEstagio(request, ['orcamento_enviado']);
    await request.patch(`${API_URL}/proposals/${perdida.id}/status`, {
      headers: authHeaders(token),
      data: { status: 'perdido', reasonLost: E2E_PROPOSALS.perdida.reasonLost },
    });

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, PIPELINE, HEADING);

    for (const label of ['Ganho', 'Perdido', 'Negociação']) {
      await expect(page.getByRole('heading', { name: label, level: 3 })).toBeVisible();
    }

    // Cada cartao dentro da coluna do seu estagio — nao apenas "na tela".
    const colunaGanho = page.getByRole('heading', { name: 'Ganho', level: 3 }).locator('../..');
    const colunaPerdido = page.getByRole('heading', { name: 'Perdido', level: 3 }).locator('../..');
    await expect(colunaGanho.getByText(`#${ganha.id.slice(0, 8)}`)).toBeVisible();
    await expect(colunaPerdido.getByText(`#${perdida.id.slice(0, 8)}`)).toBeVisible();
  });
});
