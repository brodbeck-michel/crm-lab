/**
 * Fluxo 12: paginação de `/proposals` e `/catalog` — pendencia **D7 da Onda 5**.
 *
 * A Onda 5 terminou com as duas telas carregando SO a primeira pagina: o
 * backend devolvia `pagination`, a tela ignorava, e todo registro fora das 20
 * primeiras linhas ficava inalcancavel pela UI.
 *
 * Um teste que so clica "Próxima" e confere que a tela nao quebrou nao prova
 * nada — passaria tambem com o botao desligado. Aqui a prova e de CONTEUDO:
 *
 *   1. o teste garante que existe mais de uma pagina (criando registros);
 *   2. pergunta ao CONTRATO o que esta na pagina 1 e o que esta na pagina 2;
 *   3. escolhe um registro que so existe na pagina 2 e outro que so existe na
 *      pagina 1;
 *   4. na tela: pagina 1 mostra o primeiro e NAO mostra o segundo; depois de
 *      "Próxima", inverte.
 *
 * Se a tela voltasse a carregar so a primeira pagina, o passo 4 falha.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Exam, ListExamsResponse, ListProposalsResponse, Proposal } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_USERS,
  addExamToBudget,
  apiLogin,
  authHeaders,
  catalogExamButton,
  gotoScreen,
  loginAs,
  openNewBudgetPage,
  proposalCard,
} from './helpers.js';

/** Mesmo `PAGE_SIZE` de `Proposals.tsx`, `Catalog.tsx` e `CatalogSegments.tsx`. */
const PAGE_SIZE = 20;

/** Registros criados por execucao: uma pagina cheia + folga na pagina 2. */
const CRIAR = PAGE_SIZE + 5;

/**
 * Lote do SELETOR do orçamento: 55, nao 25, de proposito.
 *
 * A versao com o defeito pedia `limit: 50` numa chamada so. Um lote de 25
 * caberia inteiro nessa unica pagina e o teste passaria COM o defeito — nao
 * provaria nada. 55 nao cabe em 50, entao o exame do fim do alfabeto so e
 * alcancavel se a tela realmente carregar alem da primeira pagina.
 */
const CRIAR_SELETOR = 55;

/**
 * ANDAIME DO CATALOGO — POR QUE NAO SE MIRA MAIS NO `pagination.total` GLOBAL
 * --------------------------------------------------------------------------
 * A versao anterior criava `PAGE_SIZE + 1 - total` exames para mirar EXATAMENTE
 * 21 no laboratorio inteiro (deixando a pagina 2 com uma linha so) e depois
 * comparava a tela com a string `${total} exames · pagina 1 de`. Nada disso e
 * estavel: `pagination.total` e do tenant inteiro e ninguem e dono dele —
 * `flow-7-catalog` cria e desativa exames, e uma base nao re-semeada acumula
 * execucao sobre execucao. Pior: o total era LIDO da API num instante e
 * comparado com a tela em outro. Foi essa a falha intermitente relatada.
 *
 * Agora cada execucao cria o proprio universo: `CRIAR` exames com um PREFIXO
 * exclusivo, e toda a paginacao acontece DENTRO do filtro de busca por esse
 * prefixo. O `total` do recorte e `CRIAR` por construcao, quantos exames mais
 * existirem no tenant, e a ordem (`name ASC`) sai do sufixo numerico dos nomes.
 */
/**
 * LIMPEZA — por que o andaime nao pode mais ficar no banco
 * --------------------------------------------------------
 * O prefixo por execucao consertou a INSTABILIDADE, mas trocou-a por um
 * ACUMULO: cada `criarLote` deixava `CRIAR` exames ATIVOS para tras. O
 * Playwright roda os arquivos em ordem alfabetica — `flow-12` vem ANTES de
 * `flow-2-approval` e `flow-isolation` —, entao mesmo num banco recem-semeado
 * esses exames "Exame PG… NN" entravam na frente de "Vitamina D" (`name ASC`)
 * e o seletor do orçamento nao alcançava mais o exame que aqueles fluxos
 * clicam. Foram exatamente as 2 falhas de 101.
 *
 * A limpeza usa o UNICO "delete" que o catalogo tem: `PATCH { isActive:false }`
 * (D-004, SERVICES.md §5 — nao existe `DELETE /exams/:id`, e `flow-7` prova
 * isso). Nada de SQL direto: o e2e fala com o produto pela superficie publica,
 * e o PATCH ainda invalida o cache de 1h do catalogo — um DELETE por fora do
 * backend deixaria listagem velha em cache.
 *
 * Isso resolve de fato, e nao so na aparencia, porque o que quebrava era
 * `GET /exams?active=true`: o seletor do orçamento (PAGES.md §4) e o unico
 * consumidor que depende do CONTEUDO de uma listagem sem termo de busca, e
 * inativo nao aparece la. Os demais consumidores do catalogo sem filtro de
 * `active` (`/catalog`, e o teste de busca aqui embaixo) miram por `search` ou
 * por id, entao a linha inativa que sobra e inerte para eles. A prova nao e
 * essa argumentacao: `desativarLote` ASSERTA que o recorte ativo ficou vazio.
 */
const prefixosParaLimpar: string[] = [];

function novoPrefixo(): string {
  const aleatorio = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const prefixo = `PG${String(Date.now()).slice(-8)}${aleatorio}`;
  // Registrado ANTES de criar: um lote que morre no meio tambem precisa sair.
  prefixosParaLimpar.push(prefixo);
  return prefixo;
}

/** Desativa tudo que carrega o prefixo e confere que o recorte ativo zerou. */
async function desativarLote(
  request: APIRequestContext,
  token: string,
  prefixo: string,
): Promise<void> {
  // `limit=100` e o `MAX_LIMIT` do backend; o loop cobre lotes maiores que isso.
  for (;;) {
    const response = await request.get(
      `${API_URL}/exams?active=true&limit=100&search=${encodeURIComponent(prefixo)}`,
      { headers: authHeaders(token) },
    );
    expect(response.status(), await response.text()).toBe(200);
    const { exams } = (await response.json()) as ListExamsResponse;
    if (exams.length === 0) break;

    for (const exam of exams) {
      const patch = await request.patch(`${API_URL}/exams/${exam.id}`, {
        headers: authHeaders(token),
        data: { isActive: false },
      });
      expect(patch.status(), await patch.text()).toBe(200);
    }
  }

  // A limpeza e VERIFICADA, nao presumida: nenhum exame do lote continua ativo.
  const sobrou = await listExams(request, token, 1, prefixo, { active: true });
  expect(sobrou.pagination.total, `andaime "${prefixo}" ficou ativo no banco`).toBe(0);
}

/** Cria `quantos` exames com o prefixo dado. Nomes ordenaveis: `… 00`, `… 01`. */
async function criarLote(
  request: APIRequestContext,
  token: string,
  prefixo: string,
  quantos: number = CRIAR,
): Promise<void> {
  for (let i = 0; i < quantos; i += 1) {
    const sufixo = String(i).padStart(2, '0');
    const criado = await request.post(`${API_URL}/exams`, {
      headers: authHeaders(token),
      data: {
        name: `Exame ${prefixo} ${sufixo}`,
        code: `${prefixo}${sufixo}`,
        pricePrivate: 30 + i,
        priceInsurance: 15 + i,
      },
    });
    expect(criado.status(), await criado.text()).toBe(201);
  }
}

async function listExams(
  request: APIRequestContext,
  token: string,
  page: number,
  search?: string,
  options: { active?: boolean } = {},
): Promise<ListExamsResponse> {
  const filtro = search === undefined ? '' : `&search=${encodeURIComponent(search)}`;
  const ativo = options.active === undefined ? '' : `&active=${String(options.active)}`;
  const response = await request.get(
    `${API_URL}/exams?page=${page}&limit=${PAGE_SIZE}${filtro}${ativo}`,
    { headers: authHeaders(token) },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ListExamsResponse;
}

async function listProposals(
  request: APIRequestContext,
  token: string,
  page: number,
): Promise<ListProposalsResponse> {
  const response = await request.get(`${API_URL}/proposals?page=${page}&limit=${PAGE_SIZE}`, {
    headers: authHeaders(token),
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ListProposalsResponse;
}

/**
 * Roda mesmo quando o teste falha — andaime de teste vermelho e o que mais
 * envenena a execucao seguinte.
 */
test.afterEach(async ({ request }) => {
  if (prefixosParaLimpar.length === 0) return;
  const token = await apiLogin(request, E2E_USERS.alfaManager);
  while (prefixosParaLimpar.length > 0) {
    const prefixo = prefixosParaLimpar.pop();
    if (prefixo === undefined) break;
    await desativarLote(request, token, prefixo);
  }
});

test.describe('Fluxo 12: paginação do catálogo (D7)', () => {
  test('a pagina 2 do catalogo alcança exame que a pagina 1 nao mostra', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const prefixo = novoPrefixo();
    await criarLote(request, token, prefixo);

    // O universo do teste e SO o lote: `total` e `CRIAR`, por construcao.
    const primeira = await listExams(request, token, 1, prefixo);
    const segunda = await listExams(request, token, 2, prefixo);
    expect(primeira.pagination.total).toBe(CRIAR);
    expect(primeira.pagination.totalPages).toBe(2);
    expect(primeira.exams).toHaveLength(PAGE_SIZE);
    expect(segunda.exams).toHaveLength(CRIAR - PAGE_SIZE);

    const idsDaPrimeira = new Set(primeira.exams.map((exam) => exam.id));
    const soNaSegunda = segunda.exams.find((exam) => !idsDaPrimeira.has(exam.id)) as Exam;
    expect(soNaSegunda, 'a pagina 2 precisa trazer exame que a 1 nao traz').toBeDefined();

    const idsDaSegunda = new Set(segunda.exams.map((exam) => exam.id));
    const soNaPrimeira = primeira.exams.find((exam) => !idsDaSegunda.has(exam.id)) as Exam;
    expect(soNaPrimeira).toBeDefined();

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, '/catalog', 'Catálogo de Exames');
    await page.getByRole('searchbox').fill(prefixo);

    const nav = page.getByRole('navigation', { name: 'Paginação de exames' });
    // O numero e do RECORTE do teste, nao do laboratorio inteiro.
    await expect(nav).toContainText(`${CRIAR} exames · página 1 de 2`);

    // Pagina 1: tem o exame da pagina 1, nao tem o da pagina 2.
    await expect(page.getByRole('cell', { name: soNaPrimeira.name, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: soNaSegunda.name, exact: true })).toHaveCount(0);

    await nav.getByRole('button', { name: 'Próxima' }).click();

    // Pagina 2: o conteudo TROCOU — e a pagina esta na URL (`?page=2`).
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(nav).toContainText(`${CRIAR} exames · página 2 de 2`);
    await expect(page.getByRole('cell', { name: soNaSegunda.name, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: soNaPrimeira.name, exact: true })).toHaveCount(0);

    // E voltar traz o conteudo da pagina 1 de novo.
    await nav.getByRole('button', { name: 'Anterior' }).click();
    await expect(page.getByRole('cell', { name: soNaPrimeira.name, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: soNaSegunda.name, exact: true })).toHaveCount(0);
  });

  /**
   * BUSCAR REINICIA A PAGINACAO — a metade da D7 que nao tinha prova nenhuma,
   * nem aqui nem em `Catalog.spec.tsx`.
   *
   * O teste anterior fazia `gotoScreen('/catalog')`, ou seja, ja estava na
   * pagina 1, e entao assertava `not.toHaveURL(/page=2/)`: verdade ANTES da
   * busca, verdade DEPOIS, com ou sem o `goToPage(1)` do `handleSearch`.
   *
   * Aqui a tela ABRE em `?page=2` e so entao o usuario busca. Sem o reinicio, a
   * tela pediria a pagina 2 do conjunto FILTRADO e continuaria em `?page=2` —
   * e as duas assercoes seguintes caem.
   */
  test('buscar reinicia a paginacao: sai da pagina 2 e volta para a 1 do filtro', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const prefixo = novoPrefixo();
    /*
     * O lote garante 2 paginas TAMBEM dentro do filtro. Sem isso, "voltou para
     * a pagina 1" poderia ser so efeito de o filtro nao ter segunda pagina.
     */
    await criarLote(request, token, prefixo);

    const filtrada = await listExams(request, token, 1, prefixo);
    expect(filtrada.pagination.total).toBe(CRIAR);
    expect(filtrada.pagination.totalPages).toBe(2);
    const primeiroDoFiltro = filtrada.exams[0] as Exam;

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, '/catalog?page=2', 'Catálogo de Exames');

    const nav = page.getByRole('navigation', { name: 'Paginação de exames' });
    await expect(nav).toContainText('página 2 de');

    await page.getByRole('searchbox').fill(prefixo);

    // Voltou para a pagina 1 — na URL e no rodape — dentro do conjunto NOVO.
    await expect(page).not.toHaveURL(/[?&]page=2/);
    await expect(nav).toContainText(`${CRIAR} exames · página 1 de 2`);
    await expect(
      page.getByRole('cell', { name: primeiroDoFiltro.name, exact: true }),
    ).toBeVisible();
  });

  test('a busca filtra de verdade: codigo unico deixa uma linha e nenhuma paginacao', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const primeira = await listExams(request, token, 1);
    const alvo = primeira.exams[0] as Exam;

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, '/catalog', 'Catálogo de Exames');

    await page.getByRole('searchbox').fill(alvo.code);

    // Sobrou a linha do alvo e sumiu a paginacao: um resultado so nao tem 2a pagina.
    await expect(page.getByRole('cell', { name: alvo.name, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Paginação de exames' })).toHaveCount(0);
  });
});

/**
 * A METADE DA D7 QUE FICOU ABERTA — o seletor de `/budget/new` (D-080).
 *
 * `/proposals` e `/catalog` ganharam `Pagination` na Onda 5; a coluna de
 * catalogo do orçamento nao, porque ninguem olhou para la. Ela pedia UMA
 * pagina (`limit: 50`) e renderizava `data.exams`: num laboratorio com mais
 * exames ativos do que isso, os demais eram INALCANÇAVEIS — nao dava para
 * montar orçamento com eles. O e2e nao pegava porque o seed tem 14 exames.
 *
 * A prova e de CONTEUDO e termina no carrinho: o exame do FIM do recorte
 * (que nao esta na primeira pagina) aparece depois de "Carregar mais" e ENTRA
 * no resumo. Com a tela de pagina unica de volta, o rodape "N de M exames"
 * nunca aparece e a primeira assercao cai.
 */
test.describe('Fluxo 12: alcance do catálogo no orçamento (D-080)', () => {
  test('exame fora da primeira pagina e alcançavel no seletor e entra no orçamento', async ({
    page,
    request,
  }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const prefixo = novoPrefixo();
    await criarLote(request, gestor, prefixo, CRIAR_SELETOR);

    const ultimaPagina = Math.ceil(CRIAR_SELETOR / PAGE_SIZE);
    const fim = await listExams(request, gestor, ultimaPagina, prefixo, { active: true });
    expect(fim.pagination.total).toBe(CRIAR_SELETOR);
    // `name ASC`: o ultimo da ultima pagina e o fim do alfabeto do recorte.
    const alvo = fim.exams[fim.exams.length - 1] as Exam;
    expect(alvo).toBeDefined();

    await loginAs(page, E2E_USERS.alfaAttendant);
    await openNewBudgetPage(page, E2E_CONVERSATIONS.atribuida.id);

    const catalogo = page.getByTestId('budget-catalog');
    await catalogo.getByRole('searchbox').fill(prefixo);

    /*
     * O rodape e a ANCORA do teste: `20 de 55 exames` so e verdade depois que
     * a busca server-side voltou (o recorte tem 55) E a tela mostrou apenas a
     * primeira pagina. Sem ele, um `toHaveCount(0)` logo apos digitar poderia
     * estar olhando para a lista ANTES da busca e passar por acidente.
     */
    const carregarMais = catalogo.getByRole('button', { name: 'Carregar mais' });
    await expect(catalogo.getByText(`${PAGE_SIZE} de ${CRIAR_SELETOR} exames`)).toBeVisible();
    await expect(catalogExamButton(page, alvo.name)).toHaveCount(0);

    await carregarMais.click();
    await expect(catalogo.getByText(`${PAGE_SIZE * 2} de ${CRIAR_SELETOR} exames`)).toBeVisible();
    await expect(catalogExamButton(page, alvo.name)).toHaveCount(0);

    await carregarMais.click();
    // Catalogo inteiro na tela: nao ha mais o que carregar, o rodape some.
    await expect(carregarMais).toHaveCount(0);

    // E o exame do fim do alfabeto e clicavel de verdade: vai para o resumo.
    await addExamToBudget(page, alvo.name);
  });

  /**
   * A outra saida para o mesmo problema: buscar recorta o catalogo INTEIRO no
   * banco, nao as 20 linhas ja carregadas. Se a busca fosse client-side, um
   * exame fora da primeira pagina continuaria invisivel por mais que se
   * digitasse o nome dele.
   */
  test('a busca do seletor alcança exame que nunca esteve na tela', async ({ page, request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const prefixo = novoPrefixo();
    await criarLote(request, gestor, prefixo, CRIAR_SELETOR);

    const ultimaPagina = Math.ceil(CRIAR_SELETOR / PAGE_SIZE);
    const fim = await listExams(request, gestor, ultimaPagina, prefixo, { active: true });
    const alvo = fim.exams[fim.exams.length - 1] as Exam;

    await loginAs(page, E2E_USERS.alfaAttendant);
    await openNewBudgetPage(page, E2E_CONVERSATIONS.atribuida.id);

    // O codigo e unico: o recorte tem UMA linha e ela nao precisa de "mais".
    await page.getByTestId('budget-catalog').getByRole('searchbox').fill(alvo.code);
    await addExamToBudget(page, alvo.name);
    await expect(
      page.getByTestId('budget-catalog').getByRole('button', { name: 'Carregar mais' }),
    ).toHaveCount(0);
  });
});

test.describe('Fluxo 12: paginação do pipeline (D7)', () => {
  test('a pagina 2 de /proposals alcança proposta que a pagina 1 nao mostra', async ({
    page,
    request,
  }) => {
    const atendente = await apiLogin(request, E2E_USERS.alfaAttendant);
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);

    /*
     * Cria uma pagina cheia + folga. A listagem ordena por `createdAt DESC`
     * (proposal.service.ts), entao as recem-criadas ocupam a pagina 1 e o
     * TRANSBORDO cai no comeco da pagina 2, que e o que o teste precisa
     * observar trocando de pagina.
     *
     * Aqui o `total` global NAO e usado como ancora: o teste so escolhe ids
     * DENTRO do conjunto que ele mesmo criou (`criadasSet`), entao quantas
     * propostas o tenant ja tinha nao muda o resultado.
     */
    const criadas: string[] = [];
    for (let i = 0; i < CRIAR; i += 1) {
      const response = await request.post(`${API_URL}/proposals`, {
        headers: authHeaders(atendente),
        data: {
          conversationId: E2E_CONVERSATIONS.pipeline.id,
          items: [{ examId: E2E_EXAMS.glicose.id, quantity: 1 }],
        },
      });
      expect(response.status()).toBe(201);
      criadas.push(((await response.json()) as { id: string }).id);
    }

    const primeira = await listProposals(request, admin, 1);
    const segunda = await listProposals(request, admin, 2);
    expect(primeira.pagination.totalPages).toBeGreaterThan(1);

    const idsDaPrimeira = new Set(primeira.proposals.map((item) => item.id));
    const criadasSet = new Set(criadas);
    const soNaSegunda = segunda.proposals.find(
      (item) => !idsDaPrimeira.has(item.id) && criadasSet.has(item.id),
    ) as Proposal;
    expect(
      soNaSegunda,
      'o transbordo das propostas criadas precisa cair na pagina 2',
    ).toBeDefined();

    const idsDaSegunda = new Set(segunda.proposals.map((item) => item.id));
    const soNaPrimeira = primeira.proposals.find(
      (item) => !idsDaSegunda.has(item.id) && criadasSet.has(item.id),
    ) as Proposal;
    expect(soNaPrimeira).toBeDefined();

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, '/proposals?view=lista', 'Pipeline de Propostas');

    await expect(proposalCard(page, soNaPrimeira)).toBeVisible();
    await expect(proposalCard(page, soNaSegunda)).toHaveCount(0);

    /*
     * `página 1 de N` sem o total: `pagination.total` de propostas e do tenant
     * inteiro e vivo (outros fluxos criam propostas), entao compara-lo com a
     * tela lida noutro instante era a mesma armadilha do catalogo. O que este
     * teste precisa provar e o CONTEUDO trocando de pagina, e isso as linhas
     * acima e abaixo fazem por id.
     */
    const nav = page.getByRole('navigation', { name: 'Paginação de propostas' });
    await expect(nav).toContainText('página 1 de');
    await nav.getByRole('button', { name: 'Próxima' }).click();

    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(nav).toContainText('página 2 de');
    await expect(proposalCard(page, soNaSegunda)).toBeVisible();
    await expect(proposalCard(page, soNaPrimeira)).toHaveCount(0);
  });

  /**
   * `?page=2` direto na URL — a metade "compartilhavel / sobrevive ao F5" da
   * D7.
   */
  test('`?page=2` na URL abre direto na pagina 2 e nao volta sozinha', async ({
    page,
    request,
  }) => {
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const segunda = await listProposals(request, admin, 2);
    const alvo = segunda.proposals[0] as Proposal;

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, '/proposals?view=lista&page=2', 'Pipeline de Propostas');

    await expect(
      page.getByRole('navigation', { name: 'Paginação de propostas' }),
    ).toContainText('página 2 de');
    await expect(proposalCard(page, alvo)).toBeVisible();
  });

  test('trocar de filtro volta para a pagina 1', async ({ page, request }) => {
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const segunda = await listProposals(request, admin, 2);
    expect(segunda.proposals.length).toBeGreaterThan(0);

    await loginAs(page, E2E_USERS.alfaAdmin);
    await gotoScreen(page, '/proposals?view=lista&page=2', 'Pipeline de Propostas');

    const nav = page.getByRole('navigation', { name: 'Paginação de propostas' });
    await expect(nav).toContainText('página 2 de');

    // Um filtro novo tem um conjunto novo: "pagina 2 do filtro antigo" nao existe.
    await page.getByPlaceholder('ID do atendente').fill(E2E_USERS.alfaAttendant.id);
    await expect(page).not.toHaveURL(/[?&]page=2/);

    // Controle positivo: o filtro realmente filtrou (as propostas listadas sao
    // todas da atendente), em vez de a tela ter apenas resetado a pagina.
    const filtrado = await request.get(
      `${API_URL}/proposals?createdBy=${E2E_USERS.alfaAttendant.id}&limit=${PAGE_SIZE}`,
      { headers: authHeaders(admin) },
    );
    expect(filtrado.status()).toBe(200);
    const proposals = ((await filtrado.json()) as ListProposalsResponse).proposals;
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((item) => item.createdBy === E2E_USERS.alfaAttendant.id)).toBe(true);
  });
});
