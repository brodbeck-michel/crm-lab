/**
 * Fluxo 13: Convenios, preco por convenio e fallback para particular —
 * PAGES.md (Convenios) · API_CONTRACTS.md §4/§8 · D-081/D-082 (Onda 7).
 *
 * O que este arquivo prova, e que nenhum teste de unidade prova sozinho:
 *
 *  1. O preco por (exame, convenio) cadastrado na aba do catalogo e o preco
 *     que o ORCAMENTO cobra — a volta completa `PUT /exams/:id/prices` ->
 *     `GET /exams?insuranceId=` -> `POST /proposals`.
 *  2. **Fallback nunca bloqueia** (D-004/D-081): exame sem linha em
 *     `exam_prices` para o convenio escolhido entra na mesma proposta pelo
 *     preco particular, com `priceSource: 'private'` no snapshot — e a tela
 *     marca esse item com o badge "Particular".
 *  3. O convenio e o snapshot de origem de preco PERSISTEM: quem reabre a
 *     proposta depois ve o mesmo convenio e as mesmas origens.
 *
 * O par (2)+(3) e o ponto: um teste que so conferisse o total passaria com o
 * `priceSource` errado — o numero seria o mesmo, a rastreabilidade nao.
 *
 * "Particular" nao tem fixture (D-082): e a AUSENCIA de convenio.
 */
import { test, expect, type Page } from '@playwright/test';
import type {
  ListExamPricesResponse,
  ListInsurancesResponse,
  ProposalDetail,
} from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_EXAM_PRICES,
  E2E_INSURANCES,
  E2E_USERS,
  addExamToBudget,
  apiLogin,
  authHeaders,
  createProposal,
  gotoScreen,
  loginAs,
  openNewBudgetPage,
  proposalCard,
} from './helpers.js';

const UNIMED = E2E_INSURANCES.unimedTubarao;

/** Hemograma tem preco proprio na Unimed (32,00 contra 38,00 particular). */
const PRECO_HEMOGRAMA_UNIMED = E2E_EXAM_PRICES.find(
  (linha) => linha.examId === E2E_EXAMS.hemograma.id && linha.insuranceId === UNIMED.id,
)?.price;

/** Glicose NAO tem linha em `exam_prices` — e o caso de fallback. */
const SEM_PRECO_DE_CONVENIO = E2E_EXAMS.glicose;

/** Nome unico por execucao: a suite roda contra um banco que ela mesma suja. */
const novoConvenio = () => `Convenio E2E ${Date.now()}`;

/** Seleciona o convenio no `InsuranceSelector` do orcamento (rotulo "Convênio"). */
async function selecionarConvenio(page: Page, nome: string): Promise<void> {
  await page.getByLabel('Convênio').selectOption({ label: nome });
}

test.describe('Fluxo 13: Convenios e preco por convenio', () => {
  test('a tela lista o convenio semeado e o admin cadastra um novo', async ({ page }) => {
    const nome = novoConvenio();

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, '/settings/insurances', 'Convênios');
    await expect(page.getByRole('cell', { name: UNIMED.name })).toBeVisible();

    await page.getByRole('button', { name: '+ Novo Convênio' }).click();
    await page.getByLabel('Nome').fill(nome);
    await page.getByLabel('Razão Social').fill(`${nome} LTDA`);
    await page.getByLabel('Tipo').selectOption('seguradora');

    const criacao = page.waitForResponse(
      (res) => res.url().includes('/insurances') && res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Criar' }).click();
    expect((await criacao).status()).toBe(201);

    // `exact` porque a coluna "Razão Social" contem o mesmo nome + " LTDA".
    await expect(page.getByRole('cell', { name: nome, exact: true })).toBeVisible();
    // Convenio nasce ativo (§8: `POST` nao aceita `isActive`).
    await expect(
      page.getByRole('row', { name: new RegExp(nome) }).getByText('Ativo'),
    ).toBeVisible();
  });

  test('o preco salvo na aba do catalogo e o preco que o orcamento cobra', async ({
    page,
    request,
  }) => {
    const preco = 19.5;

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, '/catalog', 'Catálogo de Exames');

    // Busca antes de clicar: a tabela mostra 20 exames por pagina em ordem de
    // nome, e a suite completa cria exames que empurram os semeados para fora
    // da pagina 1 (o teste passava isolado e falhava na suite inteira).
    await page.getByPlaceholder('Buscar exame...').fill(SEM_PRECO_DE_CONVENIO.name);

    // Abre o exame de fallback e da a ele um preco NA UNIMED pela tela.
    await page
      .getByRole('row', { name: new RegExp(SEM_PRECO_DE_CONVENIO.name) })
      .getByRole('button', { name: 'Editar' })
      .click();
    // `SegmentedControl` monta `role="tab"`, nao `button`.
    await page.getByRole('tab', { name: 'Preços por convênio' }).click();

    const campo = page.getByRole('spinbutton', { name: `Preço — ${UNIMED.name}` });
    await expect(campo).toBeVisible();
    await campo.fill(String(preco));

    const salvamento = page.waitForResponse(
      (res) => res.url().includes('/prices') && res.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Salvar preços' }).click();
    expect((await salvamento).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('Preços salvos.');

    // A fonte da verdade e o recurso, nao o pixel.
    const token = await apiLogin(request, E2E_USERS.alfaAdmin);
    const salvos = (await (
      await request.get(`${API_URL}/exams/${SEM_PRECO_DE_CONVENIO.id}/prices`, {
        headers: authHeaders(token),
      })
    ).json()) as ListExamPricesResponse;
    expect(salvos.prices).toContainEqual(
      expect.objectContaining({ insuranceId: UNIMED.id, price: preco }),
    );

    // E o orcamento com esse convenio cobra o preco novo.
    const criada = await request.post(`${API_URL}/proposals`, {
      headers: authHeaders(token),
      data: {
        conversationId: E2E_CONVERSATIONS.atribuida.id,
        insuranceId: UNIMED.id,
        items: [{ examId: SEM_PRECO_DE_CONVENIO.id, quantity: 1 }],
      },
    });
    expect(criada.status(), await criada.text()).toBe(201);
    const proposta = (await criada.json()) as ProposalDetail;
    expect(proposta.totalPrice).toBe(preco);
    expect(proposta.items[0]?.priceSource).toBe('insurance');

    // Limpa o preco que este teste criou: a fixture de `glicose` e "exame SEM
    // preco de convenio", e os outros testes deste arquivo dependem disso.
    const limpeza = await request.put(`${API_URL}/exams/${SEM_PRECO_DE_CONVENIO.id}/prices`, {
      headers: authHeaders(token),
      data: { prices: [] },
    });
    expect(limpeza.status()).toBe(200);
  });

  test('orcamento com convenio: preco do convenio e fallback particular convivem', async ({
    page,
    request,
  }) => {
    expect(PRECO_HEMOGRAMA_UNIMED, 'fixture de preco por convenio ausente').toBeDefined();
    const precoConvenio = PRECO_HEMOGRAMA_UNIMED as number;

    await loginAs(page, E2E_USERS.alfaAttendant);
    await openNewBudgetPage(page, E2E_CONVERSATIONS.atribuida.id);

    await selecionarConvenio(page, UNIMED.name);
    // A lista do catalogo recarrega com `insuranceId` — espere o preco novo,
    // nao um timeout.
    await expect(
      page.getByTestId('budget-catalog').getByRole('button', {
        name: new RegExp(E2E_EXAMS.hemograma.name),
      }),
    ).toContainText('32,00');

    await addExamToBudget(page, E2E_EXAMS.hemograma.name);
    await addExamToBudget(page, SEM_PRECO_DE_CONVENIO.name);

    // O badge so existe no item que caiu no particular DENTRO de uma proposta
    // com convenio — e so nele.
    const itens = page.getByTestId('summary-items');
    await expect(itens.getByTestId('price-source-badge')).toHaveCount(1);
    // A linha do item e o `div` que tem o nome E o botao de remover — o
    // `filter` por nome sozinho casa tambem o bloco interno do titulo.
    const linhaGlicose = itens.locator('> div').filter({
      has: page.getByRole('button', { name: `Remover ${SEM_PRECO_DE_CONVENIO.name}` }),
    });
    await expect(linhaGlicose.getByTestId('price-source-badge')).toContainText('Particular');
    const linhaHemograma = itens.locator('> div').filter({
      has: page.getByRole('button', { name: `Remover ${E2E_EXAMS.hemograma.name}` }),
    });
    await expect(linhaHemograma.getByTestId('price-source-badge')).toHaveCount(0);

    const proposalId = await createProposal(page);

    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const salva = (await (
      await request.get(`${API_URL}/proposals/${proposalId}`, { headers: authHeaders(token) })
    ).json()) as ProposalDetail;

    expect(salva.insuranceId).toBe(UNIMED.id);
    expect(salva.totalPrice).toBe(precoConvenio + SEM_PRECO_DE_CONVENIO.pricePrivate);

    const porExame = new Map(salva.items.map((item) => [item.examId, item]));
    expect(porExame.get(E2E_EXAMS.hemograma.id)?.priceSource).toBe('insurance');
    expect(porExame.get(E2E_EXAMS.hemograma.id)?.unitPrice).toBe(precoConvenio);
    expect(porExame.get(SEM_PRECO_DE_CONVENIO.id)?.priceSource).toBe('private');
    expect(porExame.get(SEM_PRECO_DE_CONVENIO.id)?.unitPrice).toBe(
      SEM_PRECO_DE_CONVENIO.pricePrivate,
    );

    // (3) persistencia na tela: reabrir a proposta mostra o convenio.
    await gotoScreen(page, '/proposals', 'Pipeline de Propostas');
    await proposalCard(page, proposalId).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText(UNIMED.name)).toBeVisible();
  });

  test('o convenio do Alfa nao existe para o Beta (isolamento)', async ({ request }) => {
    // O tenant Beta nao tem convenio nenhum (e2e-fixtures.ts): a lista dele e
    // vazia. `/insurances` nao tem GET por id (so lista, POST e PATCH), entao
    // o par "404 nunca FORBIDDEN" desta rota vive em
    // `backend/tests/kernel/route-tenant-isolation.spec.ts` — aqui se prova o
    // que a TELA do Beta enxerga.
    const token = await apiLogin(request, E2E_USERS.betaAttendant);

    const lista = await request.get(`${API_URL}/insurances`, { headers: authHeaders(token) });
    expect(lista.status(), await lista.text()).toBe(200);
    const corpo = (await lista.json()) as ListInsurancesResponse;
    expect(corpo.insurances).toHaveLength(0);
  });
});
