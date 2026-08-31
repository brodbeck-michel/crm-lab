/**
 * VARREDURA DE ISOLAMENTO — todas as rotas de dado de laboratorio, dois tenants
 * reais, um app so. Bloqueante de release (docs/guides/TESTING.md).
 *
 * `tests/kernel/tenant-isolation.spec.ts` prova a camada 3 (RLS no banco).
 * ESTA suite prova a camada de cima: o que a API HTTP realmente devolve quando
 * um usuario do tenant A aponta para um id do tenant B, rota por rota.
 *
 * Tres invariantes, e nenhum deles admite excecao:
 *
 *   1. Recurso de outro tenant -> 404 `NOT_FOUND`. Nunca 403, nunca 200 com
 *      dado, nunca 500 (CLAUDE.md §8 / API_ERRORS.md).
 *   2. Listagem/relatorio nunca cruza tenant — nem por id na query string.
 *   3. `platform_operator` nao tem caminho para NENHUMA rota de laboratorio
 *      (PAGES.md §11 — requisito, nao configuracao).
 *
 * A lista `LAB_ROUTES` e a fonte unica: rota nova entra ali e passa a ser
 * varrida pelos tres invariantes de uma vez.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiErrorBody,
  Channel,
  FunnelReport,
  ListAuditResponse,
  ListChannelsResponse,
  ListConversationsResponse,
  ListExamsResponse,
  ChannelSettingsResponse,
  ListPatientsResponse,
  ListProposalsResponse,
  ListUsersResponse,
  OperationOverviewResponse,
  PipelineSnapshot,
  TeamReport,
} from '@crm-lab/shared';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import { auditModule } from '../../src/controllers/audit.routes.js';
import { makeChannelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { examModule } from '../../src/controllers/exam.routes.js';
import { insuranceModule } from '../../src/controllers/insurance.routes.js';
import { internalChatModule } from '../../src/controllers/internal-chat.routes.js';
import { operationModule } from '../../src/controllers/operation.routes.js';
import { patientModule } from '../../src/controllers/patient.routes.js';
import { proposalModule } from '../../src/controllers/proposal.routes.js';
import { themeModule } from '../../src/controllers/theme.routes.js';
import { userModule } from '../../src/controllers/user.routes.js';
import type { DbClient } from '../../src/db/types.js';
import type { EvolutionClient } from '../../src/lib/evolution-client.js';
import {
  createConversation,
  createExam,
  createProposal,
  createTenant,
  createUser,
  type ConversationRecord,
  type ExamRecord,
  type ProposalRecord,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import {
  createPatient,
  linkConversation,
  type PatientRecord,
} from '../patients/helpers.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type AuthenticatableUser, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

/**
 * Gateway Evolution de mentira (Onda 7, Bloco B) — so o suficiente para as 4
 * rotas de `/settings/channels/whatsapp/*` responderem 200/204 sem rede real.
 * Inline de proposito (pre-flight da Onda 7): a extracao para um helper
 * compartilhado fica para a Task 11 (E2E), que ja usa um gateway fake maior.
 */
function fakeEvolutionClient(): EvolutionClient {
  return {
    async createInstance(instanceName: string) {
      return { instanceName, apikey: `apikey-${instanceName}` };
    },
    async getQr() {
      return { qrcode: 'data:image/png;base64,QR', status: 'pairing' };
    },
    async getStatus() {
      return { status: 'disconnected', phoneNumber: null };
    },
    async logout() {
      return undefined;
    },
    async sendText() {
      return { externalId: 'evo-sonda' };
    },
  };
}

/** Todos os modulos que servem dado de laboratorio, montados de uma vez. */
const LAB_MODULES = [
  analyticsModule,
  auditModule,
  makeChannelSettingsModule({ evolutionClient: fakeEvolutionClient() }),
  conversationModule,
  examModule,
  insuranceModule,
  internalChatModule,
  operationModule,
  patientModule,
  proposalModule,
  themeModule,
  userModule,
];

type Method = 'get' | 'post' | 'patch' | 'put';
type Actor = 'admin' | 'manager' | 'attendant';

/** Um laboratorio completo: tudo que uma rota de laboratorio consegue endereçar. */
interface Lab {
  tenant: TenantRecord;
  admin: UserRecord;
  manager: UserRecord;
  attendant: UserRecord;
  conversation: ConversationRecord;
  /** Cadastro do paciente (D-059), ligado a `conversation`. */
  patient: PatientRecord;
  exam: ExamRecord;
  /** Proposta GANHA (terminal) — e a que carrega a receita nos relatorios. */
  proposal: ProposalRecord;
  /**
   * Proposta ABERTA e ja aprovada. Existe para que a varredura "id proprio
   * devolve o status de SUCESSO" tenha um alvo em que mudar de estagio e
   * mexer no desconto sao operacoes legitimas — na proposta terminal acima,
   * as duas devolvem `409 PROPOSAL_ALREADY_CLOSED`, que nao e sucesso.
   */
  openProposal: ProposalRecord;
  /** Proposta aberta AGUARDANDO alcada — alvo legitimo de approve/reject. */
  pendingProposal: ProposalRecord;
  /** `#geral` — criado sob demanda pelo InternalChatService no primeiro GET. */
  channel: Channel;
  /** Convenio do laboratorio (Onda 7 — D-081/D-082). */
  insurance: { id: string; name: string };
}

interface LabRoute {
  /** Nome legivel — vira o titulo do caso de teste. */
  readonly name: string;
  readonly method: Method;
  /** Caminho completo, montado com os ids do laboratorio informado. */
  readonly path: (lab: Lab) => string;
  readonly body?: (lab: Lab) => Record<string, unknown>;
  /** Papel do tenant A que faz a chamada. */
  readonly actor: Actor;
  /**
   * `true` quando o caminho carrega um id de recurso: so essas rotas entram na
   * varredura "id do outro tenant -> 404".
   */
  readonly addressable: boolean;
  /**
   * Status que a rota devolve quando o id e do PROPRIO tenant — o controle
   * positivo do 404.
   *
   * Antes daqui a asserção era `not.toMatchObject({ status: 404 })`, e por isso
   * um `500` passava: qualquer explosao interna satisfaz "nao e 404" e o
   * isolamento parecia provado (defeito D4 da Onda 5). Agora cada rota declara
   * o SEU status de sucesso, e ele e conferido exatamente.
   *
   * So faz sentido em rota enderecavel; as demais ja sao exercitadas com 200
   * na varredura de listagens.
   */
  readonly ownStatus?: number;
}

/**
 * INVENTARIO DE ROTAS DE LABORATORIO.
 *
 * Confere com `src/http/modules.ts` menos `authModule` (publico),
 * `webhookModule` (publico, autenticado por HMAC) e `platformModule` (console
 * da plataforma, que e o oposto disto).
 */
const LAB_ROUTES: readonly LabRoute[] = [
  // --- conversas ---
  { name: 'GET /conversations', method: 'get', path: () => '/api/v1/conversations', actor: 'attendant', addressable: false },
  { name: 'GET /conversations/:id', method: 'get', path: (l) => `/api/v1/conversations/${l.conversation.id}`, actor: 'attendant', addressable: true, ownStatus: 200 },
  {
    name: 'PATCH /conversations/:id',
    method: 'patch',
    path: (l) => `/api/v1/conversations/${l.conversation.id}`,
    body: () => ({ status: 'archived' }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'POST /conversations/:id/messages',
    method: 'post',
    path: (l) => `/api/v1/conversations/${l.conversation.id}/messages`,
    body: () => ({ content: 'sonda de isolamento' }),
    actor: 'attendant',
    addressable: true,
    ownStatus: 201,
  },
  { name: 'POST /conversations/:id/read', method: 'post', path: (l) => `/api/v1/conversations/${l.conversation.id}/read`, actor: 'attendant', addressable: true, ownStatus: 204 },

  // --- propostas ---
  { name: 'GET /proposals', method: 'get', path: () => '/api/v1/proposals', actor: 'admin', addressable: false },
  { name: 'GET /proposals/:id', method: 'get', path: (l) => `/api/v1/proposals/${l.proposal.id}`, actor: 'admin', addressable: true, ownStatus: 200 },
  {
    name: 'POST /proposals',
    method: 'post',
    path: () => '/api/v1/proposals',
    body: (l) => ({ conversationId: l.conversation.id, items: [{ examId: l.exam.id, quantity: 1 }] }),
    actor: 'attendant',
    addressable: false,
  },
  {
    // Alvo aberto e ja aprovado: `novo_contato -> orcamento_enviado` e uma
    // transicao legitima, entao o sucesso e 200 de verdade. Na proposta
    // GANHA (terminal) esta rota devolve 409 PROPOSAL_ALREADY_CLOSED, que
    // passaria no antigo `not.toMatchObject({ status: 404 })` sem provar nada.
    name: 'PATCH /proposals/:id/status',
    method: 'patch',
    path: (l) => `/api/v1/proposals/${l.openProposal.id}/status`,
    body: () => ({ status: 'orcamento_enviado' }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'PATCH /proposals/:id/discount',
    method: 'patch',
    path: (l) => `/api/v1/proposals/${l.openProposal.id}/discount`,
    body: () => ({ discountPercent: 5 }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },
  {
    // Aprovar/rejeitar exige `approvalStatus: 'pending'` e um decisor que nao
    // seja o autor (D-046) — dai o alvo ser a proposta pendente e o ator, o gestor.
    name: 'PATCH /proposals/:id/approve',
    method: 'patch',
    path: (l) => `/api/v1/proposals/${l.pendingProposal.id}/approve`,
    actor: 'manager',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'PATCH /proposals/:id/reject',
    method: 'patch',
    path: (l) => `/api/v1/proposals/${l.pendingProposal.id}/reject`,
    body: () => ({ reason: 'sonda de isolamento' }),
    actor: 'manager',
    addressable: true,
    ownStatus: 200,
  },

  // --- catalogo ---
  { name: 'GET /exams', method: 'get', path: () => '/api/v1/exams', actor: 'attendant', addressable: false },
  {
    name: 'POST /exams',
    method: 'post',
    path: () => '/api/v1/exams',
    body: () => ({ name: 'Exame sonda', code: 'SONDA1', pricePrivate: 10, priceInsurance: 5 }),
    actor: 'manager',
    addressable: false,
  },
  {
    name: 'PATCH /exams/:id',
    method: 'patch',
    path: (l) => `/api/v1/exams/${l.exam.id}`,
    // Desativacao e PATCH { isActive: false } — nao existe DELETE /exams/:id.
    body: () => ({ isActive: false }),
    actor: 'manager',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'GET /exams/:id/prices',
    method: 'get',
    path: (l) => `/api/v1/exams/${l.exam.id}/prices`,
    actor: 'attendant',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'PUT /exams/:id/prices',
    method: 'put',
    path: (l) => `/api/v1/exams/${l.exam.id}/prices`,
    body: (l) => ({ prices: [{ insuranceId: l.insurance.id, price: 10 }] }),
    actor: 'manager',
    addressable: true,
    ownStatus: 200,
  },

  // --- convenios (Onda 7 — D-081/D-082) ---
  { name: 'GET /insurances', method: 'get', path: () => '/api/v1/insurances', actor: 'attendant', addressable: false },
  {
    name: 'POST /insurances',
    method: 'post',
    path: () => '/api/v1/insurances',
    body: () => ({ name: 'Convênio sonda', type: 'seguradora' }),
    actor: 'manager',
    addressable: false,
  },
  {
    name: 'PATCH /insurances/:id',
    method: 'patch',
    path: (l) => `/api/v1/insurances/${l.insurance.id}`,
    body: () => ({ isActive: false }),
    actor: 'manager',
    addressable: true,
    ownStatus: 200,
  },

  // --- pacientes (Onda 6 — D-059..D-063) ---
  { name: 'GET /patients', method: 'get', path: () => '/api/v1/patients', actor: 'admin', addressable: false },
  { name: 'GET /patients/:id', method: 'get', path: (l) => `/api/v1/patients/${l.patient.id}`, actor: 'admin', addressable: true, ownStatus: 200 },
  {
    name: 'PATCH /patients/:id',
    method: 'patch',
    path: (l) => `/api/v1/patients/${l.patient.id}`,
    body: () => ({ notes: 'sonda de isolamento' }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },
  { name: 'GET /patients/:id/timeline', method: 'get', path: (l) => `/api/v1/patients/${l.patient.id}/timeline`, actor: 'admin', addressable: true, ownStatus: 200 },
  // Exportar e anonimizar sao ADMIN (D-062/D-063): o papel e checado no
  // service, o guard de plataforma e da rota.
  { name: 'GET /patients/:id/export', method: 'get', path: (l) => `/api/v1/patients/${l.patient.id}/export`, actor: 'admin', addressable: true, ownStatus: 200 },
  {
    name: 'POST /patients/:id/anonymize',
    method: 'post',
    path: (l) => `/api/v1/patients/${l.patient.id}/anonymize`,
    body: () => ({ reason: 'sonda de isolamento' }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },

  // --- canais & equipe (Onda 6 — D-064..D-066) ---
  { name: 'GET /settings/channels', method: 'get', path: () => '/api/v1/settings/channels', actor: 'manager', addressable: false },
  {
    name: 'PATCH /settings/channels',
    method: 'patch',
    path: () => '/api/v1/settings/channels',
    body: () => ({ distributionMode: 'manual' }),
    actor: 'admin',
    addressable: false,
  },

  // --- conexao WhatsApp por QR (Onda 7, Bloco B) ---
  {
    name: 'POST /settings/channels/whatsapp/connect',
    method: 'post',
    path: () => '/api/v1/settings/channels/whatsapp/connect',
    body: () => ({ acceptTerms: true }),
    actor: 'admin',
    addressable: false,
  },
  {
    name: 'GET /settings/channels/whatsapp/qr',
    method: 'get',
    path: () => '/api/v1/settings/channels/whatsapp/qr',
    actor: 'admin',
    addressable: false,
  },
  {
    name: 'GET /settings/channels/whatsapp/status',
    method: 'get',
    path: () => '/api/v1/settings/channels/whatsapp/status',
    actor: 'admin',
    addressable: false,
  },
  {
    name: 'POST /settings/channels/whatsapp/disconnect',
    method: 'post',
    path: () => '/api/v1/settings/channels/whatsapp/disconnect',
    actor: 'admin',
    addressable: false,
  },

  // --- gestao da operacao (Onda 6 — D-067) ---
  { name: 'GET /operations/overview', method: 'get', path: () => '/api/v1/operations/overview', actor: 'manager', addressable: false },

  // --- usuarios & auditoria ---
  { name: 'GET /users/me', method: 'get', path: () => '/api/v1/users/me', actor: 'attendant', addressable: false },
  { name: 'GET /users', method: 'get', path: () => '/api/v1/users', actor: 'admin', addressable: false },
  {
    name: 'POST /users',
    method: 'post',
    path: () => '/api/v1/users',
    body: () => ({
      email: `sonda-${Date.now()}@lab.local`,
      name: 'Usuario Sonda',
      password: 'senha-de-teste-123',
      role: 'attendant',
    }),
    actor: 'admin',
    addressable: false,
  },
  {
    name: 'PATCH /users/:id',
    method: 'patch',
    path: (l) => `/api/v1/users/${l.attendant.id}`,
    body: () => ({ isActive: false }),
    actor: 'admin',
    addressable: true,
    ownStatus: 200,
  },
  { name: 'GET /audit', method: 'get', path: () => '/api/v1/audit', actor: 'admin', addressable: false },

  // --- tema ---
  { name: 'GET /themes/current', method: 'get', path: () => '/api/v1/themes/current', actor: 'attendant', addressable: false },
  { name: 'GET /themes/presets', method: 'get', path: () => '/api/v1/themes/presets', actor: 'attendant', addressable: false },
  {
    name: 'PATCH /themes/current',
    method: 'patch',
    path: () => '/api/v1/themes/current',
    body: () => ({ accent: '#123456' }),
    actor: 'admin',
    addressable: false,
  },

  // --- analytics ---
  { name: 'GET /analytics/conversion', method: 'get', path: () => '/api/v1/analytics/conversion', actor: 'manager', addressable: false },
  { name: 'GET /analytics/pipeline', method: 'get', path: () => '/api/v1/analytics/pipeline', actor: 'manager', addressable: false },
  { name: 'GET /analytics/team', method: 'get', path: () => '/api/v1/analytics/team', actor: 'manager', addressable: false },

  // --- chat interno ---
  { name: 'GET /internal-chat/channels', method: 'get', path: () => '/api/v1/internal-chat/channels', actor: 'attendant', addressable: false },
  {
    name: 'GET /internal-chat/channels/:id/messages',
    method: 'get',
    path: (l) => `/api/v1/internal-chat/channels/${l.channel.id}/messages`,
    actor: 'attendant',
    addressable: true,
    ownStatus: 200,
  },
  {
    name: 'POST /internal-chat/channels/:id/read',
    method: 'post',
    path: (l) => `/api/v1/internal-chat/channels/${l.channel.id}/read`,
    actor: 'attendant',
    addressable: true,
    ownStatus: 204,
  },
  {
    name: 'POST /internal-chat/channels/:id/messages',
    method: 'post',
    path: (l) => `/api/v1/internal-chat/channels/${l.channel.id}/messages`,
    body: () => ({ content: 'sonda de isolamento' }),
    actor: 'attendant',
    addressable: true,
    ownStatus: 201,
  },
] as const;

let db: DbClient;
let app: TestApp;
let alfa: Lab;
let beta: Lab;
let operator: UserRecord;

/** Marcadores que jamais podem aparecer numa resposta do outro tenant. */
const BETA_SECRETS = {
  patient: 'Paciente Confidencial Beta',
  /** Anotacao interna do cadastro (D-059): so a ficha do Beta pode mostrar. */
  notes: 'Anotacao Confidencial Beta',
  exam: 'Exame Confidencial Beta',
  user: 'Bruno Confidencial Beta',
  revenue: 4321.99,
  insurance: 'Convênio Confidencial Beta',
} as const;

async function buildLab(prefix: string, secret: boolean): Promise<Lab> {
  const tenant = await createTenant({ name: `Lab ${prefix}`, slug: `lab-${prefix}`, db });
  const admin = await createUser({ tenantId: tenant.id, role: 'admin', email: `admin@${prefix}.local`, db });
  const manager = await createUser({ tenantId: tenant.id, role: 'manager', email: `gestor@${prefix}.local`, discountLimit: 30, db });
  const attendant = await createUser({
    tenantId: tenant.id,
    role: 'attendant',
    email: `atendente@${prefix}.local`,
    name: secret ? BETA_SECRETS.user : `Atendente ${prefix}`,
    discountLimit: 15,
    db,
  });
  const conversation = await createConversation({
    tenantId: tenant.id,
    assignedTo: attendant.id,
    patientName: secret ? BETA_SECRETS.patient : `Paciente ${prefix}`,
    db,
  });
  const exam = await createExam({
    tenantId: tenant.id,
    name: secret ? BETA_SECRETS.exam : `Exame ${prefix}`,
    code: `EX-${prefix.toUpperCase()}`,
    pricePrivate: secret ? BETA_SECRETS.revenue : 100,
    db,
  });
  // O cadastro do paciente (D-059) e a conversa apontando para ele — e o que
  // a migracao 003 faz no backfill, e o que a ficha e a timeline leem.
  const patient = await createPatient({
    tenantId: tenant.id,
    phone: conversation.patientPhone,
    name: secret ? BETA_SECRETS.patient : `Paciente ${prefix}`,
    notes: secret ? BETA_SECRETS.notes : null,
    db,
  });
  await linkConversation(conversation.id, patient.id, { db });

  const proposal = await createProposal({
    tenantId: tenant.id,
    conversationId: conversation.id,
    createdBy: attendant.id,
    status: 'ganho',
    approvalStatus: 'pending',
    totalPrice: secret ? BETA_SECRETS.revenue : 100,
    items: [{ examId: exam.id, examName: exam.name, unitPrice: secret ? BETA_SECRETS.revenue : 100 }],
    db,
  });

  // Alvos do controle positivo do 404 (ver `LabRoute.ownStatus`): a proposta
  // ganha acima e terminal, e mudar estagio ou desconto nela devolve 409.
  const openProposal = await createProposal({
    tenantId: tenant.id,
    conversationId: conversation.id,
    createdBy: attendant.id,
    status: 'novo_contato',
    approvalStatus: 'approved',
    totalPrice: secret ? BETA_SECRETS.revenue : 100,
    items: [{ examId: exam.id, examName: exam.name, unitPrice: secret ? BETA_SECRETS.revenue : 100 }],
    db,
  });
  const pendingProposal = await createProposal({
    tenantId: tenant.id,
    conversationId: conversation.id,
    createdBy: attendant.id,
    status: 'novo_contato',
    discountPercent: 25,
    approvalStatus: 'pending',
    totalPrice: secret ? BETA_SECRETS.revenue : 75,
    items: [{ examId: exam.id, examName: exam.name, unitPrice: secret ? BETA_SECRETS.revenue : 100 }],
    db,
  });

  const insuranceRow = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO insurances (tenant_id, name, type) VALUES ($1, $2, 'cooperativa') RETURNING id`,
      [tenant.id, secret ? BETA_SECRETS.insurance : `Convênio ${prefix}`],
    ),
  );
  const insurance = {
    id: insuranceRow.rows[0]?.id as string,
    name: secret ? BETA_SECRETS.insurance : `Convênio ${prefix}`,
  };

  // O primeiro GET cria `#geral`/`#aprovacoes` do tenant (InternalChatService).
  const channels = await app.agent
    .get('/api/v1/internal-chat/channels')
    .set(app.auth(admin))
    .expect(200);
  const list = (channels.body as ListChannelsResponse).channels;
  const channel = list[0];
  if (!channel) throw new Error(`Nenhum canal interno criado para ${prefix}`);

  return {
    tenant,
    admin,
    manager,
    attendant,
    conversation,
    patient,
    exam,
    proposal,
    openProposal,
    pendingProposal,
    channel,
    insurance,
  };
}

function actorOf(lab: Lab, actor: Actor): AuthenticatableUser {
  return lab[actor];
}

/** Dispara a rota com o corpo certo para o metodo. */
function call(route: LabRoute, target: Lab, headers: Record<string, string>, bodyLab: Lab = target) {
  const request = app.agent[route.method](route.path(target)).set(headers);
  return route.body ? request.send(route.body(bodyLab)) : request;
}

beforeAll(async () => {
  db = await getTestDb();
  // As rotas de /settings/channels/whatsapp/* tambem exigem
  // EVOLUTION_WEBHOOK_TOKEN configurado (Important 3 da revisao da Task 5) —
  // sem ele `requireEvolutionClient` recusa com 503 mesmo com o
  // `evolutionClient` de mentira injetado, e o sweep generico desta suite
  // (que so declara comportamento, nunca segredo especifico de uma rota)
  // esperaria 200.
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'evolution-webhook-token-de-teste';
});

afterAll(() => {
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: LAB_MODULES });
  alfa = await buildLab('alfa', false);
  beta = await buildLab('beta', true);

  const plataforma = await createTenant({ name: 'Plataforma', slug: 'plataforma', db });
  operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
});

// ---------------------------------------------------------------------------
// 0. GUARDA-CORPO DO INVENTARIO
//
// `LAB_ROUTES` so vale como fonte unica se ela for provadamente igual ao que os
// routers expoem. Antes daqui havia uma contagem magica
// (`toBeGreaterThanOrEqual(11)`) que passava mesmo se duas rotas sumissem do
// inventario — exatamente o cenario que o comentario prometia detectar. Agora
// a comparacao caminha o `router.stack` de cada modulo de laboratorio.
// ---------------------------------------------------------------------------

/** Camada de `Router.stack` que corresponde a uma rota (e nao a middleware). */
interface RouteLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

/** Nomes das rotas realmente registradas, no formato de `LabRoute.name`. */
function declaredRoutes(): string[] {
  const deps = { db, cache: new MemoryCache(), wsHub: new FakeWsHub() };
  const names: string[] = [];
  for (const factory of LAB_MODULES) {
    const mod = factory(deps);
    const { stack } = mod.router as unknown as { stack: RouteLayer[] };
    for (const layer of stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled || method === '_all') continue;
          names.push(`${method.toUpperCase()} ${mod.basePath}${path === '/' ? '' : path}`);
        }
      }
    }
  }
  return names.sort();
}

describe('inventario de rotas de laboratorio', () => {
  it('LAB_ROUTES bate EXATAMENTE com o que os routers expoem', () => {
    // Igualdade de conjuntos, nao contagem: rota nova sem entrada aqui falha,
    // e rota que sumiu do inventario tambem.
    expect(declaredRoutes()).toEqual([...LAB_ROUTES].map((r) => r.name).sort());
  });

  it('sao 48 rotas de laboratorio e toda rota com `:id` entra na varredura de 404', () => {
    // Onda 6 somou 9: as 6 de `/patients`, `GET|PATCH /settings/channels` e
    // `GET /operations/overview`. Onda 7 soma 9: as 3 de `/insurances`, as 2
    // de `GET|PUT /exams/:id/prices` (preco por convenio) e as 4 de
    // `/settings/channels/whatsapp/*` (conexao por QR, Bloco B).
    expect(LAB_ROUTES).toHaveLength(48);

    const comId = LAB_ROUTES.filter((route) => route.name.includes('/:'))
      .map((route) => route.name)
      .sort();
    const marcadas = LAB_ROUTES.filter((route) => route.addressable)
      .map((route) => route.name)
      .sort();
    expect(marcadas).toEqual(comId);
  });
});

// ---------------------------------------------------------------------------
// 1. Recurso de outro tenant -> 404
// ---------------------------------------------------------------------------

describe('recurso do tenant B enderecado por um usuario do tenant A', () => {
  const addressable = LAB_ROUTES.filter((route) => route.addressable);

  for (const route of addressable) {
    it(`${route.name} devolve 404 NOT_FOUND (nunca FORBIDDEN)`, async () => {
      const headers = app.auth(actorOf(alfa, route.actor));
      // Caminho aponta para B; corpo (quando ha) usa ids de A, para que o
      // unico motivo possivel de falha seja o recurso alheio.
      const response = await call(route, beta, headers, alfa);

      expect(response.status).toBe(404);
      const body = response.body as ApiErrorBody;
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.statusCode).toBe(404);

      // Nem o nome, nem o preco, nem o total do tenant B aparecem no erro.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(BETA_SECRETS.patient);
      expect(serialized).not.toContain(BETA_SECRETS.notes);
      expect(serialized).not.toContain(BETA_SECRETS.exam);
      expect(serialized).not.toContain(BETA_SECRETS.user);
      expect(serialized).not.toContain(String(BETA_SECRETS.revenue));
      expect(serialized).not.toContain(BETA_SECRETS.insurance);
    });
  }

  /*
   * CONTROLE POSITIVO DO 404 (defeito D4 da Onda 5).
   *
   * A versao anterior era um laco unico com
   * `expect({ status }).not.toMatchObject({ status: 404 })`. Duas falhas:
   *  (a) "nao e 404" aceita QUALQUER coisa — um 500 passava, e a suite dizia
   *      que o 404 vinha do isolamento quando na verdade a rota estava quebrada;
   *  (b) o laco reusava o MESMO laboratorio, entao aprovar antes de rejeitar
   *      deixava a segunda chamada com o estado ja consumido.
   *
   * Agora cada rota e um caso proprio (portanto um `beforeEach` proprio, com
   * laboratorio novo) e afirma o SEU status de sucesso, declarado em
   * `ownStatus`.
   */
  for (const route of addressable) {
    it(`${route.name} com o id do PROPRIO tenant devolve ${route.ownStatus} — o 404 e do isolamento, nao da rota`, async () => {
      const headers = app.auth(actorOf(alfa, route.actor));
      const response = await call(route, alfa, headers, alfa);

      expect(
        { route: route.name, status: response.status, body: response.body as unknown },
      ).toMatchObject({ route: route.name, status: route.ownStatus });
    });
  }

  it('toda rota enderecavel declara o status de sucesso que espera', () => {
    // Sem isto, uma rota nova sem `ownStatus` cairia em
    // `toMatchObject({ status: undefined })`, que passa com qualquer status.
    const semDeclaracao = addressable
      .filter((route) => route.ownStatus === undefined)
      .map((route) => route.name);
    expect(semDeclaracao).toEqual([]);
  });

  it('POST /proposals com conversa do tenant B devolve 404', async () => {
    const response = await app.agent
      .post('/api/v1/proposals')
      .set(app.auth(alfa.attendant))
      .send({ conversationId: beta.conversation.id, items: [{ examId: alfa.exam.id, quantity: 1 }] });

    expect(response.status).toBe(404);
    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('POST /proposals com exame do tenant B nao cria nada nem vaza o preco', async () => {
    const response = await app.agent
      .post('/api/v1/proposals')
      .set(app.auth(alfa.attendant))
      .send({ conversationId: alfa.conversation.id, items: [{ examId: beta.exam.id, quantity: 1 }] });

    // O exame alheio e indistinguivel de um inexistente: 400
    // EXAM_NOT_FOUND_OR_INACTIVE (API_ERRORS.md, secao Propostas).
    expect(response.status).toBe(400);
    expect((response.body as ApiErrorBody).error.code).toBe('EXAM_NOT_FOUND_OR_INACTIVE');
    expect(JSON.stringify(response.body)).not.toContain(BETA_SECRETS.exam);
    expect(JSON.stringify(response.body)).not.toContain(String(BETA_SECRETS.revenue));
  });

  it('escrita recusada nao altera a linha do tenant B', async () => {
    await app.agent
      .patch(`/api/v1/exams/${beta.exam.id}`)
      .set(app.auth(alfa.manager))
      .send({ isActive: false, name: 'Sequestrado' })
      .expect(404);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ name: string; is_active: boolean }>(
        'SELECT name, is_active FROM exam_catalog WHERE id = $1',
        [beta.exam.id],
      ),
    );
    expect(row.rows[0]).toMatchObject({ name: BETA_SECRETS.exam, is_active: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Listagens e relatorios nunca cruzam o tenant
// ---------------------------------------------------------------------------

describe('listagens e relatorios do tenant A', () => {
  it('nenhuma rota de listagem devolve string do tenant B', async () => {
    const listRoutes = LAB_ROUTES.filter((route) => route.method === 'get' && !route.addressable);
    for (const route of listRoutes) {
      const response = await call(route, alfa, app.auth(actorOf(alfa, route.actor)));
      expect({ route: route.name, status: response.status }).toMatchObject({
        route: route.name,
        status: 200,
      });
      const serialized = JSON.stringify(response.body);
      for (const secret of [BETA_SECRETS.patient, BETA_SECRETS.exam, BETA_SECRETS.user, BETA_SECRETS.insurance]) {
        expect({ route: route.name, leaked: serialized.includes(secret) }).toMatchObject({
          route: route.name,
          leaked: false,
        });
      }
    }
  });

  it('GET /conversations lista so as conversas de A', async () => {
    const response = await app.agent
      .get('/api/v1/conversations?scope=all')
      .set(app.auth(alfa.admin))
      .expect(200);
    const body = response.body as ListConversationsResponse;
    expect(body.conversations.map((c) => c.id)).toEqual([alfa.conversation.id]);
  });

  it('GET /proposals lista so as propostas de A', async () => {
    const response = await app.agent.get('/api/v1/proposals').set(app.auth(alfa.admin)).expect(200);
    const body = response.body as ListProposalsResponse;
    expect(body.proposals.map((p) => p.id).sort()).toEqual(
      [alfa.proposal.id, alfa.openProposal.id, alfa.pendingProposal.id].sort(),
    );
  });

  it('GET /patients lista so os pacientes de A', async () => {
    const response = await app.agent.get('/api/v1/patients').set(app.auth(alfa.admin)).expect(200);
    const body = response.body as ListPatientsResponse;
    expect(body.patients.map((p) => p.id)).toEqual([alfa.patient.id]);
    expect(JSON.stringify(body)).not.toContain(BETA_SECRETS.notes);
  });

  it('busca de paciente pelo telefone do outro tenant nao acha nada', async () => {
    const response = await app.agent
      .get(`/api/v1/patients?search=${encodeURIComponent(beta.patient.phone)}`)
      .set(app.auth(alfa.admin))
      .expect(200);
    expect((response.body as ListPatientsResponse).patients).toHaveLength(0);
  });

  it('GET /settings/channels e GET /operations/overview so enxergam A', async () => {
    const canais = await app.agent
      .get('/api/v1/settings/channels')
      .set(app.auth(alfa.admin))
      .expect(200);
    const equipe = (canais.body as ChannelSettingsResponse).team.map((m) => m.id).sort();
    expect(equipe).toEqual([alfa.admin.id, alfa.manager.id, alfa.attendant.id].sort());

    const operacao = await app.agent
      .get('/api/v1/operations/overview')
      .set(app.auth(alfa.manager))
      .expect(200);
    const overview = operacao.body as OperationOverviewResponse;
    expect(overview.workload.map((row) => row.userId)).not.toContain(beta.attendant.id);
    expect(overview.queue.items.map((item) => item.conversationId)).not.toContain(
      beta.conversation.id,
    );
    expect(overview.pendingDecisions.items.map((item) => item.proposalId)).not.toContain(
      beta.pendingProposal.id,
    );
    expect(JSON.stringify(overview)).not.toContain(BETA_SECRETS.patient);
  });

  it('GET /exams lista so o catalogo de A', async () => {
    const response = await app.agent.get('/api/v1/exams').set(app.auth(alfa.attendant)).expect(200);
    const body = response.body as ListExamsResponse;
    expect(body.exams.map((e) => e.id)).toEqual([alfa.exam.id]);
  });

  it('GET /insurances lista so os convenios de A', async () => {
    const response = await app.agent.get('/api/v1/insurances').set(app.auth(alfa.attendant)).expect(200);
    const body = response.body as { insurances: Array<{ id: string }> };
    expect(body.insurances.map((i) => i.id)).toEqual([alfa.insurance.id]);
  });

  it('GET /users lista so os usuarios de A', async () => {
    const response = await app.agent.get('/api/v1/users').set(app.auth(alfa.admin)).expect(200);
    const body = response.body as ListUsersResponse;
    expect(body.users.map((u) => u.id).sort()).toEqual(
      [alfa.admin.id, alfa.manager.id, alfa.attendant.id].sort(),
    );
  });

  it('GET /internal-chat/channels lista so os canais de A', async () => {
    const response = await app.agent
      .get('/api/v1/internal-chat/channels')
      .set(app.auth(alfa.attendant))
      .expect(200);
    const body = response.body as ListChannelsResponse;
    expect(body.channels.length).toBeGreaterThan(0);
    expect(body.channels.some((c) => c.id === beta.channel.id)).toBe(false);
  });

  it('filtro por id de recurso do tenant B volta vazio, nao 403', async () => {
    const porConversa = await app.agent
      .get(`/api/v1/proposals?conversationId=${beta.conversation.id}`)
      .set(app.auth(alfa.admin))
      .expect(200);
    expect((porConversa.body as ListProposalsResponse).proposals).toHaveLength(0);

    const porAutor = await app.agent
      .get(`/api/v1/proposals?createdBy=${beta.attendant.id}`)
      .set(app.auth(alfa.admin))
      .expect(200);
    expect((porAutor.body as ListProposalsResponse).proposals).toHaveLength(0);

    const auditoria = await app.agent
      .get(`/api/v1/audit?entityId=${beta.proposal.id}`)
      .set(app.auth(alfa.admin))
      .expect(200);
    expect((auditoria.body as ListAuditResponse).entries).toHaveLength(0);
  });

  it('busca textual pelo nome do paciente/exame de B nao acha nada', async () => {
    const exames = await app.agent
      .get(`/api/v1/exams?search=${encodeURIComponent(BETA_SECRETS.exam)}`)
      .set(app.auth(alfa.attendant))
      .expect(200);
    expect((exames.body as ListExamsResponse).exams).toHaveLength(0);

    const usuarios = await app.agent
      .get(`/api/v1/users?search=${encodeURIComponent(BETA_SECRETS.user)}`)
      .set(app.auth(alfa.admin))
      .expect(200);
    expect((usuarios.body as ListUsersResponse).users).toHaveLength(0);
  });

  it('analytics de A nao soma a receita de B', async () => {
    const headers = app.auth(alfa.manager);

    const conversao = await app.agent.get('/api/v1/analytics/conversion').set(headers).expect(200);
    const funil = conversao.body as FunnelReport;
    expect(funil.revenue).not.toBe(BETA_SECRETS.revenue);
    expect(funil.topPerformers.map((p) => p.userId)).not.toContain(beta.attendant.id);

    const pipeline = await app.agent.get('/api/v1/analytics/pipeline').set(headers).expect(200);
    expect((pipeline.body as PipelineSnapshot).totalValue).not.toBe(BETA_SECRETS.revenue);

    const time = await app.agent.get('/api/v1/analytics/team').set(headers).expect(200);
    const equipe = time.body as TeamReport;
    expect(equipe.members.map((m) => m.userId)).not.toContain(beta.attendant.id);
    expect(equipe.totals.revenue).not.toBe(BETA_SECRETS.revenue);
  });

  it('GET /themes/current devolve o tema do proprio tenant apos o admin de A trocar a cor', async () => {
    await app.agent
      .patch('/api/v1/themes/current')
      .set(app.auth(alfa.admin))
      .send({ accent: '#abcdef' })
      .expect(200);

    const deA = await app.agent.get('/api/v1/themes/current').set(app.auth(alfa.attendant)).expect(200);
    const deB = await app.agent.get('/api/v1/themes/current').set(app.auth(beta.attendant)).expect(200);

    const temaA = (deA.body as { theme: { accent: string } }).theme;
    const temaB = (deB.body as { theme: { accent: string } }).theme;
    expect(temaA.accent.toLowerCase()).toBe('#abcdef');
    expect(temaB.accent.toLowerCase()).not.toBe('#abcdef');
  });
});

// ---------------------------------------------------------------------------
// 3. platform_operator sem caminho para dado de laboratorio
// ---------------------------------------------------------------------------

describe('platform_operator nas rotas de laboratorio', () => {
  for (const route of LAB_ROUTES) {
    it(`${route.name} recusa o operador da plataforma`, async () => {
      const response = await call(route, alfa, app.auth(operator), alfa);

      expect(response.status).toBe(403);
      expect((response.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
      // Nenhum dado de laboratorio no corpo do 403.
      expect(JSON.stringify(response.body)).not.toContain(alfa.conversation.patientName);
    });
  }

  it('o operador nao passa nem com id de recurso valido de um laboratorio', async () => {
    const headers = app.auth(operator);
    const alvos = [
      `/api/v1/conversations/${alfa.conversation.id}`,
      `/api/v1/proposals/${alfa.proposal.id}`,
      `/api/v1/internal-chat/channels/${alfa.channel.id}/messages`,
      `/api/v1/users/me`,
      `/api/v1/audit`,
    ];
    for (const alvo of alvos) {
      const response = await app.agent.get(alvo).set(headers);
      expect({ alvo, status: response.status }).toMatchObject({ alvo, status: 403 });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Sem token / token de tenant inexistente
// ---------------------------------------------------------------------------

describe('token', () => {
  it('toda rota de laboratorio exige token', async () => {
    for (const route of LAB_ROUTES) {
      const request = app.agent[route.method](route.path(alfa));
      const response = await (route.body ? request.send(route.body(alfa)) : request);
      expect({ route: route.name, status: response.status }).toMatchObject({
        route: route.name,
        status: 401,
      });
    }
  });

  it('token assinado com tenant_id de B nao alcança dado de A', async () => {
    // O tenantId vem SEMPRE do token assinado (auth middleware): forjar o
    // header/query nao muda nada — quem manda e a claim.
    const comoB = app.auth({
      id: beta.attendant.id,
      tenantId: beta.tenant.id,
      role: 'admin',
      discountLimit: 100,
    });

    await app.agent.get(`/api/v1/conversations/${alfa.conversation.id}`).set(comoB).expect(404);
    await app.agent.get(`/api/v1/proposals/${alfa.proposal.id}`).set(comoB).expect(404);

    const lista = await app.agent.get('/api/v1/conversations?scope=all').set(comoB).expect(200);
    expect((lista.body as ListConversationsResponse).conversations.map((c) => c.id)).toEqual([
      beta.conversation.id,
    ]);
  });
});
