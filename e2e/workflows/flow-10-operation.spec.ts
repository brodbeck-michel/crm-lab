/**
 * Fluxo 10: Gestão da Operação — PAGES.md §10, API_CONTRACTS.md §7 (D-067).
 *
 * A tela e SOMENTE LEITURA e tudo nela e DERIVADO de `conversations` +
 * `proposals` — nenhum numero e digitado, nenhum contador e materializado
 * (BUSINESS_RULES §5). Entao o teste nao pode se contentar com "a tela
 * carregou": ele confere que os tres blocos mostram o DADO SEMEADO.
 *
 *   - fila: a conversa `naoAtribuida` (Marcos) esta la, marcada "Sem atendente";
 *   - carga: os tres usuarios do Alfa aparecem, mesmo os zerados;
 *   - decisoes pendentes: a proposta de 25% de Juliana (`pendenteAprovacao`)
 *     esta na lista, e o cartao abre o Modal da Proposta.
 *
 * Este arquivo roda ANTES de `flow-2-approval` (ordem alfabetica de arquivo:
 * `flow-10` < `flow-2`), que e quando a proposta semeada ainda esta pendente.
 *
 * O atendente e barrado nos dois lados: o guard desvia a tela e a API devolve
 * 403 — com controle positivo ao lado, para que "nao vejo" nao se confunda com
 * "nada carregou".
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { OperationOverviewResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_PATIENTS,
  E2E_PROPOSALS,
  E2E_TENANTS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  pageHeading,
  type ApiErrorEnvelope,
} from './helpers.js';

const OPERACAO_PATH = '/settings/operation';
const HEADING = 'Gestão da Operação';

/*
 * EXPECTATIVA VINDA DO SEED, NAO DA RESPOSTA
 * ------------------------------------------
 * Conferir a tela contra `overview.queue.unassigned` — a resposta do MESMO
 * endpoint que a tela chama — e quase infalsificavel: os dois lados erram
 * juntos. Aqui os dois numeros da fila sao DERIVADOS das fixtures do seed, do
 * mesmo jeito que o bloco de contrato deste arquivo faz com pacientes e
 * propostas.
 *
 * A regra da fila (SERVICES.md §14): conversa ATIVA e (sem dono OU com nao
 * lida). Todas as conversas semeadas nascem `active` (`seeds/e2e.ts`).
 */
const CONVERSAS_DO_ALFA = Object.values(E2E_CONVERSATIONS).filter(
  (conversa) => conversa.tenantId === E2E_TENANTS.alfa.id,
);
/** `naoAtribuida` (Marcos) — a unica sem dono. */
const ESPERADO_SEM_ATENDENTE = CONVERSAS_DO_ALFA.filter(
  (conversa) => conversa.assignedTo === null,
).length;
/** `aprovacao` (Juliana) — atribuida e com 1 nao lida. */
const ESPERADO_AGUARDANDO = CONVERSAS_DO_ALFA.filter(
  (conversa) => conversa.assignedTo !== null && conversa.unreadCount > 0,
).length;

async function fetchOverview(
  request: APIRequestContext,
  token: string,
): Promise<OperationOverviewResponse> {
  const response = await request.get(`${API_URL}/operations/overview?queueLimit=100&decisionsLimit=100`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as OperationOverviewResponse;
}

test.describe('Fluxo 10: Gestão da Operação (gestor le)', () => {
  test('o retrato do contrato traz a fila, a carga e as decisoes semeadas', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const overview = await fetchOverview(request, token);

    // --- fila: contagens conferidas contra o SEED, nao contra si mesmas ---
    expect(overview.queue.unassigned).toBe(ESPERADO_SEM_ATENDENTE);
    expect(overview.queue.waiting).toBe(ESPERADO_AGUARDANDO);
    const naoAtribuida = overview.queue.items.find(
      (item) => item.conversationId === E2E_CONVERSATIONS.naoAtribuida.id,
    );
    expect(naoAtribuida, 'a conversa sem atendente precisa aparecer na fila').toBeDefined();
    expect(naoAtribuida?.reason).toBe('unassigned');
    expect(naoAtribuida?.assignedTo).toBeNull();
    expect(naoAtribuida?.patientName).toBe(E2E_PATIENTS.marcos.name);
    // Tempo chega em SEGUNDOS ja calculados em UTC no SQL (D-021).
    expect(typeof naoAtribuida?.waitingSeconds).toBe('number');
    expect(overview.queue.oldestWaitSeconds).not.toBeNull();

    // --- carga: usuario ativo aparece mesmo zerado ---
    const porUsuario = new Map(overview.workload.map((row) => [row.userId, row]));
    for (const usuario of [
      E2E_USERS.alfaAdmin,
      E2E_USERS.alfaManager,
      E2E_USERS.alfaAttendant,
    ]) {
      expect(porUsuario.get(usuario.id), `${usuario.name} na carga`).toBeDefined();
      expect(porUsuario.get(usuario.id)?.role).toBe(usuario.role);
    }
    // A atendente e a dona das conversas semeadas — nao pode estar zerada.
    expect(porUsuario.get(E2E_USERS.alfaAttendant.id)?.activeConversations).toBeGreaterThan(0);

    // --- decisoes pendentes: a proposta de 25% do seed ---
    const pendente = overview.pendingDecisions.items.find(
      (item) => item.proposalId === E2E_PROPOSALS.pendenteAprovacao.id,
    );
    expect(pendente, 'a proposta acima da alçada precisa estar nas decisoes').toBeDefined();
    expect(pendente?.discountPercent).toBe(E2E_PROPOSALS.pendenteAprovacao.discountPercent);
    // Dinheiro no fio e numero decimal, nunca string formatada (CLAUDE.md §9).
    expect(pendente?.totalPrice).toBe(E2E_PROPOSALS.pendenteAprovacao.expectedTotal);
    expect(pendente?.patientName).toBe(E2E_PATIENTS.juliana.name);
    expect(pendente?.createdByName).toBe(E2E_USERS.alfaAttendant.name);
    expect(overview.pendingDecisions.total).toBeGreaterThanOrEqual(1);
  });

  test('a tela mostra os mesmos numeros do contrato', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const overview = await fetchOverview(request, token);

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, OPERACAO_PATH, HEADING);

    /*
     * Blocos da fila. O bloco e localizado pelo TEXTO DE APOIO, que so existe
     * nele: "Sem atendente" tambem e o rotulo do chip de motivo na tabela.
     *
     * O valor esperado vem do SEED (`ESPERADO_*`), nao de `overview.queue.*`:
     * comparar a tela com a resposta do endpoint que ela mesma chamou faria os
     * dois lados errarem juntos. O `overview` continua sendo conferido logo
     * abaixo — contra a mesma expectativa — para que uma divergencia entre
     * contrato e tela apareca como divergencia, e nao como empate.
     *
     * E `getByText(..., { exact: true })` dentro do bloco, nao `toContainText`
     * sobre a `div` inteira: "1" aparece em qualquer lugar de um bloco que
     * tambem imprime rotulo e texto de apoio.
     */
    const bloco = (apoio: string) => page.locator('div').filter({ hasText: apoio }).last();

    const semAtendente = bloco('Conversas ativas sem ninguém responsável.');
    await expect(semAtendente.getByText(String(ESPERADO_SEM_ATENDENTE), { exact: true }))
      .toBeVisible();
    expect(overview.queue.unassigned).toBe(ESPERADO_SEM_ATENDENTE);

    const aguardando = bloco('Atribuídas, com mensagem não lida.');
    await expect(aguardando.getByText(String(ESPERADO_AGUARDANDO), { exact: true }))
      .toBeVisible();
    expect(overview.queue.waiting).toBe(ESPERADO_AGUARDANDO);

    /*
     * As duas tabelas da tela citam o mesmo nome — a fila mostra o atendente
     * RESPONSAVEL pela conversa e a carga mostra o atendente como linha. Sem
     * escopo por secao, `getByRole('row').filter({ hasText: 'Ana Atendente' })`
     * casa as duas e o Playwright quebra em "strict mode violation". O escopo
     * tambem e o que torna a asserção honesta: "esta linha esta NA fila" e
     * diferente de "este texto existe em algum lugar da pagina".
     */
    const secao = (titulo: string) =>
      page.locator('section').filter({ has: page.getByRole('heading', { name: titulo }) });

    const linhaFila = secao('Fila agora')
      .getByRole('row')
      .filter({ hasText: E2E_PATIENTS.marcos.name });
    await expect(linhaFila).toBeVisible();
    await expect(linhaFila).toContainText('Sem atendente');
    await expect(linhaFila).toContainText('Não atribuída');

    // Carga: uma linha por usuario ativo, com o papel escrito.
    const linhaAna = secao('Carga por atendente')
      .getByRole('row')
      .filter({ hasText: E2E_USERS.alfaAttendant.name });
    await expect(linhaAna).toBeVisible();
    await expect(linhaAna).toContainText('Atendente');

    // Decisoes pendentes: o cartao da proposta de 25% de Juliana.
    const cartao = page.getByRole('button', {
      name: `Abrir proposta de ${E2E_PATIENTS.juliana.name}`,
    });
    await expect(cartao.first()).toBeVisible();
    await expect(cartao.first()).toContainText(
      `${E2E_PROPOSALS.pendenteAprovacao.discountPercent}% de desconto`,
    );
    await expect(cartao.first()).toContainText('138,00');
  });

  test('o cartao de decisao pendente abre o Modal da Proposta', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, OPERACAO_PATH, HEADING);

    await page
      .getByRole('button', { name: `Abrir proposta de ${E2E_PATIENTS.juliana.name}` })
      .first()
      .click();

    const modal = page.getByTestId('modal-card');
    await expect(modal).toBeVisible();
    await expect(modal.getByText(E2E_PATIENTS.juliana.name).first()).toBeVisible();
    // O modal traz a decisao de alçada — a tela de operacao nao a reimplementa.
    await expect(modal).toContainText('138,00');
  });

  test('a tela e do laboratorio inteiro, nao so do gestor: admin ve o mesmo', async ({
    request,
  }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);

    const doGestor = await fetchOverview(request, gestor);
    const doAdmin = await fetchOverview(request, admin);

    expect(doAdmin.workload.map((row) => row.userId).sort()).toEqual(
      doGestor.workload.map((row) => row.userId).sort(),
    );
    expect(doAdmin.pendingDecisions.items.map((item) => item.proposalId)).toContain(
      E2E_PROPOSALS.pendenteAprovacao.id,
    );
  });
});

test.describe('Fluxo 10: Gestão da Operação (atendente barrado)', () => {
  test('atendente e desviado da tela e recusado pela API', async ({ page, request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);

    const tentativa = await request.get(`${API_URL}/operations/overview`, {
      headers: authHeaders(token),
    });
    expect(tentativa.status()).toBe(403);
    expect(((await tentativa.json()) as ApiErrorEnvelope).error.code).toBe('FORBIDDEN');
    // Nem um pedaço do retrato viaja no corpo do 403.
    expect(await tentativa.text()).not.toContain(E2E_PATIENTS.marcos.name);

    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto(OPERACAO_PATH);

    await expect(page).toHaveURL(/\/attendance$/);
    await expect(pageHeading(page, HEADING)).toHaveCount(0);
  });

  test('o recorte de `queueLimit` corta a lista, mas nao os totais', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);

    const completo = await fetchOverview(request, token);
    const recortado = await request.get(`${API_URL}/operations/overview?queueLimit=1`, {
      headers: authHeaders(token),
    });
    expect(recortado.status()).toBe(200);
    const body = (await recortado.json()) as OperationOverviewResponse;

    expect(body.queue.items.length).toBeLessThanOrEqual(1);
    // Os contadores sao da fila INTEIRA — o recorte e so da lista (§7).
    expect(body.queue.unassigned).toBe(completo.queue.unassigned);
    expect(body.queue.waiting).toBe(completo.queue.waiting);

    // Faixa validada no service: 0 e fora da faixa 1..100.
    const invalido = await request.get(`${API_URL}/operations/overview?queueLimit=0`, {
      headers: authHeaders(token),
    });
    expect(invalido.status()).toBe(400);
    expect(((await invalido.json()) as ApiErrorEnvelope).error.code).toBe('VALIDATION_ERROR');
  });
});
