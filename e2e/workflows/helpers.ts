/**
 * Apoio dos specs de Playwright.
 *
 * Tres regras que este arquivo segue e que os specs herdam:
 *
 *  1. **Seletor por papel/rotulo/testid**, nunca `text=` solto. `text=Catálogo`
 *     casa o titulo da coluna, o rotulo do segmento E o item da sidebar — tres
 *     nos, e o Playwright quebra em "strict mode violation".
 *  2. **Espera por condicao**, nunca `waitForTimeout`. Um `sleep(300)` passa numa
 *     maquina rapida e falha em CI; um `toBeVisible()` espera o que precisar.
 *  3. **Zero string de fixture solta**: tudo vem de
 *     `backend/src/db/seeds/e2e-fixtures.ts` (pedido do Agent-DB-Seeds em
 *     STATUS.md).
 *
 * NOTA HISTORICA: a versao anterior usava
 * `page.locator('text=Catálogo') || page.locator('text=Exames')`. Em JS o `||`
 * devolve o operando da esquerda sempre que ele for truthy — e um `Locator` e
 * um objeto, portanto sempre truthy. O fallback nunca existiu: o codigo era
 * identico a `page.locator('text=Catálogo')`. O equivalente correto e
 * `locator.or(outroLocator)`, do proprio Playwright.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type {
  Channel,
  ListChannelsResponse,
  LoginResponse,
  Proposal,
  Theme,
  UserRole,
} from '@crm-lab/shared';
import { formatProposalNumber } from '@crm-lab/shared';
import {
  E2E_APPROVAL_POST,
  E2E_CHANNEL_READS,
  E2E_CHANNEL_UNREAD,
  E2E_CHANNELS,
  E2E_CONVERSATIONS,
  E2E_EXAM_PRICES,
  E2E_EXAMS,
  E2E_EXAMS_BETA,
  E2E_INSURANCES,
  E2E_PASSWORD,
  E2E_PATIENTS,
  E2E_PROPOSALS,
  E2E_TENANT_CHANNELS,
  E2E_TENANT_SETTINGS,
  E2E_TENANT_WITHOUT_SETTINGS,
  E2E_TENANTS,
  E2E_USERS,
  type E2eExamPrice,
  type E2eInsurance,
  type E2ePatient,
  type E2eTenantChannel,
  type E2eUser,
} from '../../backend/src/db/seeds/e2e-fixtures.js';

export {
  E2E_APPROVAL_POST,
  E2E_CHANNEL_READS,
  E2E_CHANNEL_UNREAD,
  E2E_CHANNELS,
  E2E_CONVERSATIONS,
  E2E_EXAM_PRICES,
  E2E_EXAMS,
  E2E_EXAMS_BETA,
  E2E_INSURANCES,
  E2E_PASSWORD,
  E2E_PATIENTS,
  E2E_PROPOSALS,
  E2E_TENANT_CHANNELS,
  E2E_TENANT_SETTINGS,
  E2E_TENANT_WITHOUT_SETTINGS,
  E2E_TENANTS,
  E2E_USERS,
};
export type { E2eExamPrice, E2eInsurance, E2ePatient, E2eTenantChannel, E2eUser };

/** Base da API. O Playwright fala com o backend direto nos testes de contrato. */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';

/** Home por papel — espelha `frontend/src/routes/route-config.ts` (`ROLE_HOME`). */
export const HOME_BY_ROLE: Readonly<Record<UserRole, string>> = {
  attendant: '/attendance',
  manager: '/proposals',
  admin: '/proposals',
  platform_operator: '/platform/tenants',
};

/** Variavel CSS que carrega a cor de acento (`frontend/src/lib/theme.ts`). */
export const ACCENT_CSS_VAR = '--color-accent';

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

/**
 * Faz login pela tela e espera a home do papel.
 *
 * Os campos sao localizados pelo `<label>` (o primitivo `Input` associa via
 * `htmlFor`), nao por `input[type=...]` — o tipo do campo e detalhe visual.
 */
export async function loginAs(page: Page, user: E2eUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(user.email);
  await page.getByLabel('Senha').fill(user.password);

  const resposta = page.waitForResponse(
    (res) => res.url().includes('/auth/login') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Entrar' }).click();

  // Se o login falhar (429 do rate limit, senha trocada, backend fora), a
  // mensagem do servidor entra no erro do teste — melhor que um timeout de URL
  // que so diz "continuei em /login".
  const login = await resposta;
  expect(login.status(), `POST /auth/login de ${user.email}: ${await login.text()}`).toBe(200);

  const home = HOME_BY_ROLE[user.role];
  await expect(page).toHaveURL(new RegExp(`${home}$`));
}

/** Apaga a sessao persistida (`crm-lab.session`) — usado antes de trocar de usuario. */
export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.removeItem('crm-lab.session'));
}

/**
 * Cache de tokens por e-mail.
 *
 * `POST /auth/login` e ANONIMO, entao o rate limit dele conta por IP
 * (`RATE_LIMIT_PER_MINUTE`, 100/min por padrao) — e a suite inteira sai do
 * mesmo IP. Sem cache, cada teste gastava 2 a 5 logins e a suite se
 * auto-derrubava com 429 no meio do caminho.
 *
 * O `accessToken` vale 15 minutos (`JWT_ACCESS_TTL`), mais que a suite toda.
 * O cache vive no processo do worker; um worker novo faz o seu login.
 */
const tokenCache = new Map<string, string>();

/** Login direto na API. Devolve o `accessToken` para chamadas de contrato. */
export async function apiLogin(request: APIRequestContext, user: E2eUser): Promise<string> {
  const cached = tokenCache.get(user.email);
  if (cached) return cached;

  const response = await request.post(`${API_URL}/auth/login`, {
    data: { email: user.email, password: user.password },
  });
  expect(response.status(), `login de ${user.email}: ${await response.text()}`).toBe(200);
  const body = (await response.json()) as LoginResponse;
  tokenCache.set(user.email, body.accessToken);
  return body.accessToken;
}

/** Descarta o token guardado (usuario desativado, papel trocado, senha nova). */
export function forgetToken(user: Pick<E2eUser, 'email'>): void {
  tokenCache.delete(user.email);
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Corpo de erro de `docs/api/API_ERRORS.md`. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string; statusCode: number; details?: Record<string, unknown> };
}

/**
 * Afirma que a rota devolve 404 `NOT_FOUND` — o contrato do isolamento.
 * `FORBIDDEN` aqui seria um vazamento: confirmaria que o recurso existe.
 */
export async function expectNotFound(
  request: APIRequestContext,
  token: string,
  path: string,
): Promise<void> {
  const response = await request.get(`${API_URL}${path}`, { headers: authHeaders(token) });
  expect(response.status(), `${path} deveria ser 404`).toBe(404);
  const body = (await response.json()) as ApiErrorEnvelope;
  expect(body.error.code, `${path} nao pode devolver FORBIDDEN`).toBe('NOT_FOUND');
}

// ---------------------------------------------------------------------------
// Navegacao e asserções de tela
// ---------------------------------------------------------------------------

/** Titulo `<h1>` da tela — ancora estavel para "a tela carregou". */
export function pageHeading(page: Page, name: string | RegExp): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/** Vai para a rota e espera o `<h1>` esperado aparecer. */
export async function gotoScreen(page: Page, path: string, heading: string | RegExp): Promise<void> {
  await page.goto(path);
  await expect(pageHeading(page, heading)).toBeVisible();
}

/**
 * Afirma que um texto NAO existe na pagina.
 *
 * Usa `toHaveCount(0)` em vez de `not.toBeVisible()`: o segundo passa tambem
 * quando o no existe mas esta fora da viewport — que e exatamente o vazamento
 * que estes testes procuram.
 */
export async function expectAbsent(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false })).toHaveCount(0);
}

/** Valor efetivo de uma variavel CSS no `<html>`. */
export async function cssVar(page: Page, name: string): Promise<string> {
  return (
    await page.evaluate(
      (variable) =>
        getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
      name,
    )
  ).toLowerCase();
}

/** Acento aplicado no momento. Vem de `applyTheme()` (D-005). */
export async function currentAccent(page: Page): Promise<string> {
  return cssVar(page, ACCENT_CSS_VAR);
}

// ---------------------------------------------------------------------------
// Orçamento (`/budget/new`)
// ---------------------------------------------------------------------------

/** Abre `/budget/new` e espera a coluna do catalogo. */
export async function openNewBudgetPage(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/budget/new?conversationId=${conversationId}`);
  await expect(page.getByTestId('budget-catalog')).toBeVisible();
  // O catalogo chega por request: espere um botao de exame, nao um timeout.
  await expect(
    page.getByTestId('budget-catalog').getByRole('button').filter({ hasText: /R\$/ }).first(),
  ).toBeVisible();
}

/** Botao do exame na coluna do catalogo (escopo evita casar com o resumo). */
export function catalogExamButton(page: Page, examName: string): Locator {
  return page.getByTestId('budget-catalog').getByRole('button', { name: new RegExp(escapeRe(examName)) });
}

/** Adiciona um exame e espera ele aparecer na lista de itens do resumo. */
export async function addExamToBudget(page: Page, examName: string): Promise<void> {
  await catalogExamButton(page, examName).click();
  await expect(page.getByTestId('summary-items').getByText(examName, { exact: false })).toBeVisible();
}

/**
 * Campo de desconto do resumo.
 *
 * Localizado por `role=spinbutton`, nao por `getByLabel('Desconto (%)')`: o
 * rotulo de `DiscountSection` e um `<label>` SOLTO, sem `htmlFor` e sem
 * envolver o campo — ou seja, nao esta associado ao input para tecnologia
 * assistiva nem para o Playwright. (Achado de acessibilidade: o primitivo
 * `Input` tem prop `label` que faz a associacao certa; o componente nao a usa.)
 */
export function discountField(page: Page): Locator {
  return page.getByTestId('budget-summary').getByRole('spinbutton');
}

/** Preenche o campo "Desconto (%)" do resumo. */
export async function setDiscount(page: Page, percentValue: number): Promise<void> {
  const field = discountField(page);
  await field.fill(String(percentValue));
  await expect(field).toHaveValue(String(percentValue));
}

/** Total exibido no resumo, ja em numero (o fio traz `179.80`, a tela `R$ 179,80`). */
export async function getTotalPrice(page: Page): Promise<number> {
  const row = page.getByTestId('budget-summary').locator('div', { hasText: /^Total/ }).last();
  return parseMoney((await row.textContent()) ?? '');
}

/**
 * Primeiro valor em reais de um texto: `"... R$ 1.234,56 ..."` -> `1234.56`.
 *
 * Ancorado no `R$` de proposito. Uma linha de tabela tambem contem codigo,
 * prazo em horas e travessoes (`—`); um regex de "qualquer numero" pescava o
 * primeiro deles e devolvia lixo.
 */
export function parseMoney(text: string): number {
  const match = text.replace(/\u00A0/g, ' ').match(/R\$\s*(-?[\d.]*\d(?:,\d{2})?)/);
  if (!match?.[1]) return Number.NaN;
  return Number(match[1].replace(/\./g, '').replace(',', '.'));
}

/**
 * Cria a proposta e espera a resposta do backend.
 * Devolve o `id` gerado — o 201 e a unica fonte confiavel dele.
 */
export async function createProposal(page: Page): Promise<string> {
  const pending = page.waitForResponse(
    (res) => res.url().includes('/proposals') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Criar Orçamento' }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

// ---------------------------------------------------------------------------
// Pipeline (`/proposals`)
// ---------------------------------------------------------------------------

/**
 * Cartao da proposta no pipeline.
 *
 * O `ProposalCard` imprime `formatProposalNumber(proposalNumber)` — o numero
 * sequencial por tenant de D-103 (`#000042`), nao mais o prefixo do UUID. Por
 * isso o parametro e a PROPOSTA, nao o id: o numero so existe na resposta da
 * API, e nao ha como deriva-lo do id.
 *
 * O numero e unico dentro do tenant, entao qualquer proposta e enderecavel por
 * aqui — inclusive as semeadas, que antes dividiam o prefixo `a0000000`.
 */
export function proposalCard(page: Page, proposal: Pick<Proposal, 'proposalNumber'>): Locator {
  return page
    .getByRole('button')
    .filter({ hasText: formatProposalNumber(proposal.proposalNumber) });
}

/** Escapa um texto para uso dentro de `RegExp`. */
export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tema atual do tenant, lido pela API (fonte de verdade da persistencia). */
export async function fetchCurrentTheme(
  request: APIRequestContext,
  token: string,
): Promise<Theme> {
  const response = await request.get(`${API_URL}/themes/current`, { headers: authHeaders(token) });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { theme: Theme }).theme;
}

// ---------------------------------------------------------------------------
// Chat interno (`/internal-chat`) — Onda 6, D-068
// ---------------------------------------------------------------------------

/**
 * Lista os canais internos do usuario do token.
 *
 * Os ids dos canais e2e sao derivados por hash no seed (`e2e-fixtures.ts`
 * guarda a CHAVE, nunca o id): quem precisa do id pergunta a API.
 */
export async function fetchChannels(
  request: APIRequestContext,
  token: string,
): Promise<Channel[]> {
  const response = await request.get(`${API_URL}/internal-chat/channels`, {
    headers: authHeaders(token),
  });
  expect(response.status(), `GET /internal-chat/channels: ${await response.text()}`).toBe(200);
  return ((await response.json()) as ListChannelsResponse).channels;
}

/** Canal pela CHAVE (`geral` / `aprovacoes`). Falha se o canal nao existir. */
export async function fetchChannelByKey(
  request: APIRequestContext,
  token: string,
  key: string,
): Promise<Channel> {
  const channels = await fetchChannels(request, token);
  const found = channels.find((channel) => channel.key === key);
  expect(found, `canal #${key} nao existe para este usuario`).toBeDefined();
  return found as Channel;
}

/** Marca o canal como lido (D-068). Devolve `204` e e idempotente. */
export async function markChannelRead(
  request: APIRequestContext,
  token: string,
  channelId: string,
): Promise<void> {
  const response = await request.post(
    `${API_URL}/internal-chat/channels/${channelId}/read`,
    { headers: authHeaders(token) },
  );
  expect(response.status(), `POST .../read: ${await response.text()}`).toBe(204);
}

/**
 * Badge de nao lidas do canal na coluna da esquerda do Chat Interno.
 *
 * O `Badge` NAO renderiza nada quando a contagem e `0` — entao "badge zerado"
 * se prova com `toHaveCount(0)`, e "badge com N" com o texto do circulo.
 */
export function channelUnreadBadge(page: Page, channelName: string): Locator {
  return page
    .getByTestId('channel-item')
    .filter({ hasText: channelName })
    .locator('[aria-label*="mensagens não lidas"]');
}

/** Botao do canal na coluna de canais do Chat Interno. */
export function channelButton(page: Page, channelName: string): Locator {
  return page.getByTestId('channel-item').filter({ hasText: channelName });
}
