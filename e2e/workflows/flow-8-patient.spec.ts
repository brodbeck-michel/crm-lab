/**
 * Fluxo 8: Ficha do Paciente — PAGES.md §3, API_CONTRACTS.md §2c
 * (D-059 a D-063).
 *
 * O que este spec prova, e por que cada peca esta aqui:
 *
 *  - a ficha abre pelo id do PACIENTE (nao o da conversa) e mostra o cadastro
 *    semeado em `E2E_PATIENTS.carla`;
 *  - editar o cadastro PERSISTE: o teste recarrega a pagina e le de novo, em
 *    vez de confiar no estado que o React ja tinha em memoria;
 *  - a timeline pagina de verdade — a **pagina 2 alcança uma interacao que a
 *    pagina 1 nao mostra**. O alvo e escolhido pela API (a lista da pagina 2
 *    menos a da pagina 1), nunca "clicar em Próxima e ver se nao quebrou";
 *  - o cartao de orçamento da ficha abre o Modal da Proposta com o dado certo;
 *  - o caminho LGPD: **admin exporta**, e **quem nao e admin nao ve a secao**
 *    (com controle positivo ao lado — o nao-admin ve o resto da ficha, entao a
 *    ausencia da secao nao e "a tela nao carregou").
 *
 * Nenhuma string de fixture solta: tudo vem de `e2e-fixtures.ts`.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type {
  ListPatientTimelineResponse,
  PatientDetail,
  PatientExport,
  PatientTimelineEntry,
  ProposalDetail,
} from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_PATIENTS,
  E2E_PROPOSALS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  escapeRe,
  expectAbsent,
  gotoScreen,
  loginAs,
  logout,
  pageHeading,
  proposalCard,
  type ApiErrorEnvelope,
} from './helpers.js';

const CARLA = E2E_PATIENTS.carla;
/** Outro paciente do MESMO tenant — o numero que o 409 de D-106 protege. */
const MARCOS = E2E_PATIENTS.marcos;
const FICHA = `/patients/${CARLA.id}`;

/** Mesmo `PAGE_SIZE` de `PatientTimeline.tsx` — a tela pede 20 por pagina. */
const TIMELINE_PAGE_SIZE = 20;

const LGPD_HEADING = 'Dados pessoais (LGPD)';

/** Marca unica por execucao: o preview da mensagem vira o alvo do teste. */
function runMark(): string {
  return `QA-TL-${String(Date.now()).slice(-7)}`;
}

async function fetchPatient(
  request: APIRequestContext,
  token: string,
  patientId: string,
): Promise<PatientDetail> {
  const response = await request.get(`${API_URL}/patients/${patientId}`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as PatientDetail;
}

async function fetchTimelinePage(
  request: APIRequestContext,
  token: string,
  patientId: string,
  page: number,
): Promise<ListPatientTimelineResponse> {
  const response = await request.get(
    `${API_URL}/patients/${patientId}/timeline?page=${page}&limit=${TIMELINE_PAGE_SIZE}&order=desc`,
    { headers: authHeaders(token) },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ListPatientTimelineResponse;
}

/**
 * Enche a timeline de Carla ate existir uma pagina 2.
 *
 * As mensagens sao mandadas pela ROTA de conversas (`POST
 * /conversations/:id/messages`), nao por INSERT: a timeline tem que enxergar o
 * mesmo caminho que a operacao real usa.
 */
async function sendMessages(
  request: APIRequestContext,
  token: string,
  mark: string,
  howMany: number,
): Promise<void> {
  for (let i = 1; i <= howMany; i += 1) {
    const response = await request.post(
      `${API_URL}/conversations/${E2E_CONVERSATIONS.atribuida.id}/messages`,
      { headers: authHeaders(token), data: { content: `${mark} mensagem ${i}` } },
    );
    expect([200, 201]).toContain(response.status());
  }
}

/** Previa exibida na linha da timeline (o `preview` de `kind: 'message'`). */
function previewOf(entry: PatientTimelineEntry): string | null {
  return entry.kind === 'message' ? entry.preview : null;
}

/** Navega a timeline da ficha para a pagina pedida clicando em "Próxima". */
async function goToTimelinePage(page: Page, target: number): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Paginação de interações' });
  await expect(nav).toBeVisible();
  for (let current = 1; current < target; current += 1) {
    await expect(nav).toContainText(`página ${current} de`);
    await nav.getByRole('button', { name: 'Próxima' }).click();
    await expect(nav).toContainText(`página ${current + 1} de`);
  }
}

test.describe('Fluxo 8: Ficha do Paciente (cadastro)', () => {
  test('a ficha abre pelo id do paciente e mostra o cadastro semeado', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, FICHA, CARLA.name);

    // O telefone e a identidade do paciente (D-061): aparece no cabecalho.
    await expect(page.getByText(CARLA.phone).first()).toBeVisible();

    // O cadastro chega preenchido com o que o seed gravou.
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(CARLA.name);
    await expect(page.getByLabel('E-mail')).toHaveValue(CARLA.email ?? '');
    await expect(page.getByLabel('Data de nascimento')).toHaveValue(CARLA.birthDate ?? '');
    await expect(page.getByLabel('Anotações internas')).toHaveValue(CARLA.notes ?? '');

    // Telefone e editavel desde D-106 (reverte D-061) — mas continua sendo a
    // chave que reconhece o paciente no WhatsApp, e a tela diz isso.
    const telefone = page.getByLabel('Telefone', { exact: true });
    await expect(telefone).toHaveValue(CARLA.phone);
    await expect(telefone).toBeEnabled();
  });

  test('editar o cadastro persiste — a nota volta depois do F5', async ({ page, request }) => {
    const nota = `Anotação QA ${Date.now()}`;

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, FICHA, CARLA.name);

    const campo = page.getByLabel('Anotações internas');
    await campo.fill(nota);

    const salvo = page.waitForResponse(
      (res) =>
        res.url().includes(`/patients/${CARLA.id}`) && res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Salvar cadastro' }).click();
    const resposta = await salvo;
    expect(resposta.status(), await resposta.text()).toBe(200);
    await expect(page.getByText('Cadastro salvo.')).toBeVisible();

    // Persistiu no BANCO, nao so no estado do React: recarrega e le de novo.
    await page.reload();
    await expect(pageHeading(page, CARLA.name)).toBeVisible();
    await expect(page.getByLabel('Anotações internas')).toHaveValue(nota);

    // E o contrato concorda com a tela.
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const detalhe = await fetchPatient(request, token, CARLA.id);
    expect(detalhe.notes).toBe(nota);
  });

  /**
   * D-106 (reverte D-061): corrigir um numero digitado errado nao exige mais
   * recriar o cadastro. O que NAO mudou e a unicidade `(tenant_id, phone)`:
   * assumir o numero de outro paciente e recusado com `409`, nunca funde os
   * dois cadastros.
   *
   * O telefone de CARLA e lido por outros testes deste arquivo (o export LGPD
   * confere `dump.patient.phone`), entao o `finally` devolve o valor do seed
   * mesmo se uma expectativa falhar no meio.
   */
  test('o telefone e editavel pelo contrato, mas nao pode ser o de outro paciente (D-106)', async ({
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const novo = '+5548999118877';

    try {
      const aceita = await request.patch(`${API_URL}/patients/${CARLA.id}`, {
        headers: authHeaders(token),
        data: { phone: novo },
      });
      expect(aceita.status(), await aceita.text()).toBe(200);
      expect((await fetchPatient(request, token, CARLA.id)).phone).toBe(novo);

      // Numero que ja pertence a outro paciente do tenant: recusado.
      const conflito = await request.patch(`${API_URL}/patients/${CARLA.id}`, {
        headers: authHeaders(token),
        data: { phone: MARCOS.phone },
      });
      expect(conflito.status(), await conflito.text()).toBe(409);
      const corpo = (await conflito.json()) as ApiErrorEnvelope;
      expect(corpo.error.code).toBe('CONFLICT');
      expect(corpo.error.details?.reason).toBe('phone_already_in_use');

      // A recusa nao gravou pela metade: o numero segue o que o PATCH aceitou.
      expect((await fetchPatient(request, token, CARLA.id)).phone).toBe(novo);
    } finally {
      const restaurado = await request.patch(`${API_URL}/patients/${CARLA.id}`, {
        headers: authHeaders(token),
        data: { phone: CARLA.phone },
      });
      expect(restaurado.status(), await restaurado.text()).toBe(200);
    }
  });
});

test.describe('Fluxo 8: Ficha do Paciente (timeline paginada)', () => {
  test('a pagina 2 da timeline alcança interacao que a pagina 1 nao mostra', async ({
    page,
    request,
  }) => {
    const mark = runMark();
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    // Uma pagina cheia + folga: com 25 mensagens novas, a pagina 2 existe e
    // carrega marcadores desta execucao.
    await sendMessages(request, token, mark, TIMELINE_PAGE_SIZE + 5);

    const primeira = await fetchTimelinePage(request, token, CARLA.id, 1);
    const segunda = await fetchTimelinePage(request, token, CARLA.id, 2);
    expect(primeira.pagination.totalPages).toBeGreaterThan(1);

    const idsDaPrimeira = new Set(primeira.entries.map((entry) => entry.id));
    const alvo = segunda.entries.find(
      (entry) => !idsDaPrimeira.has(entry.id) && previewOf(entry)?.includes(mark) === true,
    );
    expect(alvo, 'a pagina 2 precisa trazer uma mensagem desta execucao').toBeDefined();
    const textoAlvo = previewOf(alvo as PatientTimelineEntry) as string;

    // Um texto que SO existe na pagina 1 — o controle positivo do "avancei".
    const soNaPrimeira = primeira.entries
      .map(previewOf)
      .find((preview): preview is string => preview !== null && preview.includes(mark));
    expect(soNaPrimeira).toBeDefined();

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, FICHA, CARLA.name);
    await expect(page.getByRole('heading', { name: 'Histórico de interações' })).toBeVisible();

    // Pagina 1: tem o texto da pagina 1, NAO tem o alvo da pagina 2.
    await expect(page.getByText(soNaPrimeira as string).first()).toBeVisible();
    await expectAbsent(page, textoAlvo);

    // Pagina 2: o alvo aparece, e o texto exclusivo da pagina 1 sai da tela.
    await goToTimelinePage(page, 2);
    await expect(page.getByText(textoAlvo).first()).toBeVisible();
    await expectAbsent(page, soNaPrimeira as string);
  });

  test('o filtro por tipo muda o conteudo da timeline', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const somenteOrcamentos = await request.get(
      `${API_URL}/patients/${CARLA.id}/timeline?kind=proposal_created&limit=${TIMELINE_PAGE_SIZE}`,
      { headers: authHeaders(token) },
    );
    expect(somenteOrcamentos.status()).toBe(200);
    const entries = ((await somenteOrcamentos.json()) as ListPatientTimelineResponse).entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.kind === 'proposal_created')).toBe(true);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, FICHA, CARLA.name);

    await page.getByLabel('Filtrar tipo de interação').selectOption('proposal_created');
    // "Orçamento criado" e o rotulo da especie; "Mensagem ·" e o da outra.
    await expect(page.getByText('Orçamento criado').first()).toBeVisible();
    await expectAbsent(page, 'Mensagem · Atendente');
  });
});

test.describe('Fluxo 8: Ficha do Paciente (orçamentos)', () => {
  test('o cartao de orçamento da ficha abre o Modal da Proposta', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    // Proposta propria do teste: o cartao e endereçado pelo numero sequencial
    // que a API devolve na criacao (ver `proposalCard`).
    const criada = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        items: [{ examId: E2E_EXAMS.psa.id, quantity: 1 }],
      },
    });
    expect(criada.status()).toBe(201);
    const proposta = (await criada.json()) as ProposalDetail;

    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, FICHA, CARLA.name);
    await expect(page.getByRole('heading', { name: 'Orçamentos do paciente' })).toBeVisible();

    const cartao = proposalCard(page, proposta);
    await expect(cartao).toBeVisible();
    await cartao.click();

    const modal = page.getByTestId('modal-card');
    await expect(modal).toBeVisible();
    // O modal e da proposta CLICADA: nome do paciente, item e total conferem.
    await expect(modal.getByText(CARLA.name).first()).toBeVisible();
    await expect(modal.getByText(new RegExp(escapeRe(E2E_EXAMS.psa.name))).first()).toBeVisible();
    await expect(modal).toContainText('72,00');
  });

  test('a ficha conta os orçamentos que o solicitante enxerga', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const detalhe = await fetchPatient(request, token, CARLA.id);

    // O seed deixa a proposta ganha na conversa de Carla; os testes acrescentam
    // outras. O contador nunca pode ficar abaixo do que o seed garante.
    expect(detalhe.proposalCount).toBeGreaterThanOrEqual(1);
    expect(detalhe.conversationCount).toBeGreaterThanOrEqual(1);
    expect(detalhe.lastInteractionAt).not.toBeNull();

    const doSeed = await request.get(
      `${API_URL}/proposals?patientId=${CARLA.id}&limit=100`,
      { headers: authHeaders(token) },
    );
    expect(doSeed.status()).toBe(200);
    const ids = ((await doSeed.json()) as { proposals: Array<{ id: string }> }).proposals.map(
      (item) => item.id,
    );
    expect(ids).toContain(E2E_PROPOSALS.ganha.id);
  });
});

test.describe('Fluxo 8: Ficha do Paciente (LGPD)', () => {
  test('admin ve a secao LGPD e exporta os dados do titular', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, FICHA, CARLA.name);

    await expect(page.getByRole('heading', { name: LGPD_HEADING })).toBeVisible();

    const exportacao = page.waitForResponse(
      (res) => res.url().includes(`/patients/${CARLA.id}/export`) && res.status() === 200,
    );
    await page.getByRole('button', { name: 'Exportar dados do paciente' }).click();
    const resposta = await exportacao;

    // O dump traz o titular — nao um objeto vazio com 200.
    const dump = (await resposta.json()) as PatientExport;
    expect(dump.patient.id).toBe(CARLA.id);
    expect(dump.patient.phone).toBe(CARLA.phone);
    expect(dump.conversations.length).toBeGreaterThan(0);
    expect(dump.generatedAt).not.toBe('');

    await expect(page.getByText('Exportação gerada.')).toBeVisible();
  });

  test('quem nao e admin NAO ve a secao LGPD — mas ve o resto da ficha', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, FICHA, CARLA.name);

    // Controle positivo: a ficha carregou inteira para o gestor.
    await expect(page.getByRole('heading', { name: 'Cadastro', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Histórico de interações' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Orçamentos do paciente' })).toBeVisible();

    // E a secao restrita simplesmente nao existe — nem o botao dela.
    await expect(page.getByRole('heading', { name: LGPD_HEADING })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exportar dados do paciente' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Anonimizar cadastro' })).toHaveCount(0);

    await logout(page);
  });

  test('a API recusa export e anonimizacao de quem nao e admin', async ({ request }) => {
    for (const usuario of [E2E_USERS.alfaManager, E2E_USERS.alfaAttendant]) {
      const token = await apiLogin(request, usuario);

      const exportacao = await request.get(`${API_URL}/patients/${CARLA.id}/export`, {
        headers: authHeaders(token),
      });
      expect(exportacao.status(), `export para ${usuario.role}`).toBe(403);
      expect(((await exportacao.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');

      const anonimizacao = await request.post(`${API_URL}/patients/${CARLA.id}/anonymize`, {
        headers: authHeaders(token),
        data: { reason: 'tentativa nao autorizada do E2E' },
      });
      expect(anonimizacao.status(), `anonymize para ${usuario.role}`).toBe(403);
    }

    // Controle positivo do par: o cadastro segue intacto e NAO anonimizado.
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const detalhe = await fetchPatient(request, admin, CARLA.id);
    expect(detalhe.anonymizedAt).toBeNull();
    expect(detalhe.phone).toBe(CARLA.phone);
  });
});

/**
 * A ficha alcancada pela NAVEGACAO, nao pela URL (D-079).
 *
 * Todos os testes acima entram em `/patients/:id` por `page.goto` — e foi
 * exatamente isso que escondeu o defeito: a rota existia, tinha permissao
 * registrada e NENHUM link no produto inteiro. Um atendente logado nao
 * conseguia abrir a ficha de ninguem, e a suite passava.
 *
 * Estes testes comecam sempre em `/attendance`, sem nunca digitar a URL da
 * ficha: se o link sumir de novo, eles ficam vermelhos.
 */
test.describe('Fluxo 8: a ficha tem porta de entrada (D-079)', () => {
  test('coluna 3 do Atendimento: "Ver ficha completa" leva a ficha certa', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto('/attendance');

    // Abre a conversa da Carla pela lista — como um atendente faria.
    await page.getByTestId('conversation-item').filter({ hasText: CARLA.name }).first().click();

    const link = page.getByTestId('patient-profile-link');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(new RegExp(`${escapeRe(FICHA)}$`));
    await expect(pageHeading(page, CARLA.name)).toBeVisible();
    await expect(page.getByLabel('Telefone', { exact: true })).toHaveValue(CARLA.phone);
  });

  test('busca do inbox: o resultado de paciente abre a ficha', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto('/attendance');

    // A MESMA busca da coluna 1 consulta `GET /patients` (API_CONTRACTS §2c).
    const busca = page.waitForResponse(
      (res) => res.url().includes('/patients?') && res.request().method() === 'GET',
    );
    await page.getByLabel('Buscar paciente, telefone ou exame').fill(CARLA.name);
    await page.getByLabel('Buscar paciente, telefone ou exame').press('Enter');
    expect((await busca).status()).toBe(200);

    const resultado = page.getByTestId('patient-result').filter({ hasText: CARLA.name }).first();
    await expect(resultado).toBeVisible();
    await resultado.click();

    await expect(page).toHaveURL(new RegExp(`${escapeRe(FICHA)}$`));
    await expect(pageHeading(page, CARLA.name)).toBeVisible();
  });
});
