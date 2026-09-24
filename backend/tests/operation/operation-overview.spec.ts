/**
 * `GET /api/v1/operations/overview` — Gestao da Operacao (API_CONTRACTS.md §7,
 * SERVICES.md §14, D-067).
 *
 * O cenario e montado A MAO, com esperas escolhidas, para que os numeros
 * esperados sejam conferiveis sem reimplementar a query no teste:
 *
 *   Ana (atendente)  -> 1 conversa ativa com 2 nao lidas (espera 3h)
 *                       1 proposta aberta + 1 pendente de alcada (a mais velha)
 *   Bruno (atendente)-> 1 conversa ativa LIDA (nao entra na fila)
 *                       1 proposta pendente de alcada (mais nova)
 *   Carla (atendente)-> ZERADA de proposito: precisa aparecer, nao sumir
 *   + 2 conversas sem dono (esperas de 30 min e 90 min)
 *   + 1 conversa arquivada e 1 fechada, que NAO entram em nada
 *
 * As assercoes de tempo usam faixa (`>=` esperado, `<` esperado + folga) porque
 * o relogio anda entre o INSERT e o SELECT. A faixa e estreita o bastante para
 * pegar erro de fuso (D-021), que desloca o valor em HORAS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { operationModule } from '../../src/controllers/operation.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  createProposal,
  createTenant,
  createUser,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/operations/overview';

/** Folga em segundos aceita entre montar o cenario e ler o retrato. */
const SLACK = 120;

let db: DbClient;
let app: TestApp;
let tenantId: string;
let admin: UserRecord;
let manager: UserRecord;
let ana: UserRecord;
let bruno: UserRecord;
let carla: UserRecord;

interface ConversationSpec {
  tenantId: string;
  assignedTo?: string | null;
  unreadCount?: number;
  status?: 'active' | 'closed';
  /** Ha quantos segundos foi a ultima mensagem. */
  ageSeconds: number;
  patientName?: string;
  channel?: string;
}

/**
 * Conversa com idade CONTROLADA. A factory padrao usa `NOW()` e nao expoe
 * `unread_count`, e os dois sao exatamente o que esta tela mede.
 *
 * `NOW() - INTERVAL` grava com a mesma conversao de fuso que o `NOW()` da
 * leitura usa, entao a diferenca medida e a idade pedida, qualquer que seja o
 * fuso da sessao do banco.
 */
async function seedConversation(spec: ConversationSpec): Promise<string> {
  const id = randomUUID();
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO conversations (id, tenant_id, patient_phone, patient_name, assigned_to,
                                  channel, status, unread_count, last_message_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               NOW() - ($9 || ' seconds')::interval,
               NOW() - ($9 || ' seconds')::interval)`,
      [
        id,
        spec.tenantId,
        `+5548${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
        spec.patientName ?? 'Paciente',
        spec.assignedTo ?? null,
        spec.channel ?? 'whatsapp',
        spec.status ?? 'active',
        spec.unreadCount ?? 0,
        String(spec.ageSeconds),
      ],
    ),
  );
  return id;
}

/** Envelhece uma proposta ja criada (a factory sempre grava `NOW()`). */
async function ageProposal(id: string, ageSeconds: number): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `UPDATE proposals SET created_at = NOW() - ($2 || ' seconds')::interval WHERE id = $1`,
      [id, String(ageSeconds)],
    ),
  );
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [operationModule] });

  const tenant = await createTenant({ name: 'Lab Vida', slug: 'lab-vida', db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Zeca Admin', db });
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora Bia', db });
  ana = await createUser({ tenantId, role: 'attendant', name: 'Ana Souza', db });
  bruno = await createUser({ tenantId, role: 'attendant', name: 'Bruno Lima', db });
  carla = await createUser({ tenantId, role: 'attendant', name: 'Carla Dias', db });
});

/** Monta o cenario descrito no cabecalho. Devolve os ids que as specs conferem. */
async function seedScenario(): Promise<{
  anaConversation: string;
  pendingOld: string;
  pendingNew: string;
}> {
  const anaConversation = await seedConversation({
    tenantId,
    assignedTo: ana.id,
    unreadCount: 2,
    ageSeconds: 3 * 3600,
    patientName: 'Joao Santos',
  });
  await seedConversation({
    tenantId,
    assignedTo: bruno.id,
    unreadCount: 0,
    ageSeconds: 10 * 3600,
    patientName: 'Lida e respondida',
  });
  await seedConversation({ tenantId, ageSeconds: 30 * 60, patientName: 'Sem dono recente' });
  await seedConversation({ tenantId, ageSeconds: 90 * 60, patientName: 'Sem dono antiga' });
  // Nao-ativas nunca entram: seriam a fila de ontem.
  await seedConversation({ tenantId, status: 'closed', ageSeconds: 50 * 3600 });
  await seedConversation({
    tenantId,
    status: 'closed',
    assignedTo: ana.id,
    unreadCount: 9,
    ageSeconds: 60 * 3600,
  });

  const aberta = await createProposal({
    tenantId,
    conversationId: anaConversation,
    createdBy: ana.id,
    status: 'negociacao',
    totalPrice: 300,
    db,
  });
  const pendingOld = await createProposal({
    tenantId,
    conversationId: anaConversation,
    createdBy: ana.id,
    status: 'orcamento_enviado',
    approvalStatus: 'pending',
    discountPercent: 25,
    totalPrice: 150,
    db,
  });
  const pendingNew = await createProposal({
    tenantId,
    conversationId: anaConversation,
    createdBy: bruno.id,
    status: 'orcamento_enviado',
    approvalStatus: 'pending',
    discountPercent: 30,
    totalPrice: 200,
    db,
  });
  // Terminal: NAO conta como aberta (TERMINAL_STATUSES de @crm-lab/shared).
  await createProposal({
    tenantId,
    conversationId: anaConversation,
    createdBy: ana.id,
    status: 'ganho',
    totalPrice: 500,
    db,
  });

  await ageProposal(pendingOld.id, 4 * 3600);
  await ageProposal(pendingNew.id, 1 * 3600);
  void aberta;

  return { anaConversation, pendingOld: pendingOld.id, pendingNew: pendingNew.id };
}

function inRange(value: number, expected: number): void {
  expect(value).toBeGreaterThanOrEqual(expected);
  expect(value).toBeLessThan(expected + SLACK);
}

// ---------------------------------------------------------------------------
// Os numeros
// ---------------------------------------------------------------------------

describe('GET /operations/overview — os numeros do cenario montado a mao', () => {
  it('fila: contagens, ordem por espera e reason correto', async () => {
    await seedScenario();
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);

    expect(res.body.queue.unassigned).toBe(2);
    expect(res.body.queue.waiting).toBe(1);
    expect(res.body.queue.items).toHaveLength(3);

    const [primeiro, segundo, terceiro] = res.body.queue.items;
    // Ordem: 3h (Ana) > 90min (sem dono) > 30min (sem dono).
    expect(primeiro.patientName).toBe('Joao Santos');
    expect(primeiro.reason).toBe('waiting');
    expect(primeiro.assignedTo).toBe(ana.id);
    expect(primeiro.assignedToName).toBe('Ana Souza');
    expect(primeiro.unreadCount).toBe(2);
    inRange(primeiro.waitingSeconds, 3 * 3600);

    expect(segundo.patientName).toBe('Sem dono antiga');
    expect(segundo.reason).toBe('unassigned');
    expect(segundo.assignedTo).toBeNull();
    inRange(segundo.waitingSeconds, 90 * 60);

    expect(terceiro.patientName).toBe('Sem dono recente');
    inRange(terceiro.waitingSeconds, 30 * 60);

    // Conversa lida e atribuida NAO esta na fila; arquivada/fechada tampouco.
    const nomes = res.body.queue.items.map((i: { patientName: string }) => i.patientName);
    expect(nomes).not.toContain('Lida e respondida');

    // `generatedAt` e ISO-UTC do proprio banco, nao um `Date` do driver.
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.now() - Date.parse(res.body.generatedAt))).toBeLessThan(
      SLACK * 1000,
    );
  });

  /**
   * D-078. `last_message_at`/`p.created_at` sao TIMESTAMP SEM fuso; se a conta
   * usasse `NOW()` cru, o Postgres converteria a coluna pelo `TimeZone` da
   * SESSAO e um servidor em `America/Sao_Paulo` deslocaria toda espera em
   * 10.800 s. A conexao de producao fixa `timezone=UTC` (`pg-driver.ts`), e a
   * query usa `NOW() AT TIME ZONE 'UTC'` — este teste tira o primeiro cinto
   * para provar que o segundo segura sozinho.
   */
  it('esperas nao mudam com o TimeZone da sessao do banco (D-078)', async () => {
    await seedScenario();
    try {
      await db.exec("SET TimeZone='America/Sao_Paulo';");
      const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);

      const [primeiro, segundo, terceiro] = res.body.queue.items;
      inRange(primeiro.waitingSeconds, 3 * 3600);
      inRange(segundo.waitingSeconds, 90 * 60);
      inRange(terceiro.waitingSeconds, 30 * 60);
      inRange(res.body.queue.oldestWaitSeconds, 3 * 3600);

      const [velha] = res.body.pendingDecisions.items;
      inRange(velha.waitingSeconds, 4 * 3600);

      // `generatedAt` ja era imune (`AT TIME ZONE 'UTC'`) — segue imune.
      expect(Math.abs(Date.now() - Date.parse(res.body.generatedAt))).toBeLessThan(
        SLACK * 1000,
      );
    } finally {
      await db.exec("SET TimeZone='UTC';");
    }
  });

  /**
   * O cenario padrao NAO consegue provar isto: a fila sai ordenada por
   * `waitingSeconds DESC`, entao o item nº 1 do recorte E o mais antigo, e
   * `Math.max(...items)` daria a mesma resposta que a agregacao — exatamente o
   * "numero certo por acidente" que o cabecalho de `operation.repository.ts`
   * descreve. Um teste com `queueLimit=1` sobre o cenario padrao e tautologico.
   *
   * Para separar as duas leituras e preciso um item que fique NO TOPO do
   * recorte sem ser o mais antigo. `conversations.created_at` e
   * `last_message_at` sao os dois NULLABLE no schema (migration 001), e uma
   * conversa sem nenhum dos dois tem espera DESCONHECIDA:
   *
   *   - `MAX(...)` do Postgres IGNORA o NULL -> a maior espera continua 3h;
   *   - `ORDER BY waiting_seconds DESC` usa NULLS FIRST (default do Postgres)
   *     -> essa conversa encabeca a lista, e `toNumber(null)` a devolve com
   *     `waitingSeconds: 0`.
   *
   * Com `queueLimit=1` o unico item devolvido tem espera 0 e a fila inteira tem
   * 3h. Derivar o campo dos itens devolvidos responde 0 e o teste fica vermelho.
   */
  it('oldestWaitSeconds e da fila INTEIRA, nao dos itens devolvidos', async () => {
    await seedScenario();

    // Conversa na fila (ativa, sem dono) e SEM relogio: espera desconhecida.
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO conversations (id, tenant_id, patient_phone, patient_name, assigned_to,
                                    channel, status, unread_count, last_message_at, created_at)
         VALUES ($1, $2, '+5548900000000', 'Sem relogio', NULL,
                 'whatsapp', 'active', 0, NULL, NULL)`,
        [randomUUID(), tenantId],
      ),
    );

    const res = await app.agent
      .get(`${URL}?queueLimit=1`)
      .set(app.auth(manager))
      .expect(200);

    // O recorte devolve UM item, e e o da espera desconhecida (NULLS FIRST).
    expect(res.body.queue.items).toHaveLength(1);
    expect(res.body.queue.items[0].patientName).toBe('Sem relogio');
    expect(res.body.queue.items[0].waitingSeconds).toBe(0);

    // Contagens e maior espera continuam as da fila INTEIRA.
    expect(res.body.queue.unassigned).toBe(3);
    expect(res.body.queue.waiting).toBe(1);
    inRange(res.body.queue.oldestWaitSeconds, 3 * 3600);
  });

  it('fila vazia responde zeros e oldestWaitSeconds null', async () => {
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);
    expect(res.body.queue).toMatchObject({ unassigned: 0, waiting: 0, oldestWaitSeconds: null });
    expect(res.body.queue.items).toEqual([]);
  });

  it('carga: atendente sem carga aparece ZERADO, nao some', async () => {
    await seedScenario();
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);

    // Todo usuario ativo de papel de laboratorio, `name ASC`.
    expect(res.body.workload.map((w: { name: string }) => w.name)).toEqual([
      'Ana Souza',
      'Bruno Lima',
      'Carla Dias',
      'Gestora Bia',
      'Zeca Admin',
    ]);

    const linha = (name: string): Record<string, number> =>
      res.body.workload.find((w: { name: string }) => w.name === name);

    expect(linha('Ana Souza')).toMatchObject({
      role: 'attendant',
      activeConversations: 1,
      unreadMessages: 2,
      // negociacao + orcamento_enviado pendente = 2 abertas; `ganho` nao conta.
      openProposals: 2,
      pendingApprovals: 1,
    });
    expect(linha('Bruno Lima')).toMatchObject({
      activeConversations: 1,
      unreadMessages: 0,
      openProposals: 1,
      pendingApprovals: 1,
    });
    // Carla existe e esta zerada — some seria esconder quem esta ocioso.
    expect(linha('Carla Dias')).toMatchObject({
      activeConversations: 0,
      unreadMessages: 0,
      openProposals: 0,
      pendingApprovals: 0,
    });
  });

  it('carga nao lista usuario inativo nem operador de plataforma', async () => {
    await createUser({ tenantId, role: 'attendant', name: 'Ze Inativo', isActive: false, db });
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);
    const nomes = res.body.workload.map((w: { name: string }) => w.name);
    expect(nomes).not.toContain('Ze Inativo');
    expect(res.body.workload.every((w: { role: string }) => w.role !== 'platform_operator'))
      .toBe(true);
  });

  it('decisoes pendentes: a mais VELHA primeiro, com total completo', async () => {
    const ids = await seedScenario();
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);

    expect(res.body.pendingDecisions.total).toBe(2);
    expect(res.body.pendingDecisions.pagination).toEqual({
      page: 1,
      limit: 25,
      total: 2,
      totalPages: 1,
    });

    const [velha, nova] = res.body.pendingDecisions.items;
    expect(velha.proposalId).toBe(ids.pendingOld);
    expect(velha.createdByName).toBe('Ana Souza');
    expect(velha.patientName).toBe('Joao Santos');
    expect(velha.discountPercent).toBe(25);
    // Dinheiro no fio e numero decimal, nunca string formatada.
    expect(velha.totalPrice).toBe(150);
    inRange(velha.waitingSeconds, 4 * 3600);

    expect(nova.proposalId).toBe(ids.pendingNew);
    inRange(nova.waitingSeconds, 1 * 3600);
  });

  it('decisionsLimit recorta os itens mas nao o total', async () => {
    await seedScenario();
    const res = await app.agent
      .get(`${URL}?decisionsLimit=1`)
      .set(app.auth(manager))
      .expect(200);

    expect(res.body.pendingDecisions.items).toHaveLength(1);
    expect(res.body.pendingDecisions.total).toBe(2);
    expect(res.body.pendingDecisions.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

describe('limites', () => {
  it('acima do maximo e VALIDATION_ERROR, nao corte silencioso', async () => {
    for (const query of ['queueLimit=101', 'decisionsLimit=101', 'queueLimit=0']) {
      const res = await app.agent.get(`${URL}?${query}`).set(app.auth(manager)).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('sem query usa o default 25', async () => {
    const res = await app.agent.get(URL).set(app.auth(manager)).expect(200);
    expect(res.body.pendingDecisions.pagination.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Papeis
// ---------------------------------------------------------------------------

describe('papeis validados no servidor', () => {
  it('gestor e admin leem', async () => {
    await app.agent.get(URL).set(app.auth(manager)).expect(200);
    await app.agent.get(URL).set(app.auth(admin)).expect(200);
  });

  it('atendente e recusado', async () => {
    const res = await app.agent.get(URL).set(app.auth(ana)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
  });

  it('platform_operator e recusado pelo guard de plataforma', async () => {
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plat', db });
    const operador = await createUser({
      tenantId: plataforma.id,
      role: 'platform_operator',
      db,
    });
    const res = await app.agent.get(URL).set(app.auth(operador)).expect(403);
    expect(res.body.error.details.requiredRoles).toEqual(['attendant', 'manager', 'admin']);
  });

  it('sem token: 401', async () => {
    await app.agent.get(URL).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Isolamento multitenant
// ---------------------------------------------------------------------------

describe('isolamento entre dois laboratorios', () => {
  it('fila, carga e decisoes de B nao aparecem para A', async () => {
    await seedScenario();

    const outro = await createTenant({ name: 'Lab Beta', slug: 'lab-beta', db });
    const managerB = await createUser({
      tenantId: outro.id,
      role: 'manager',
      name: 'Gestor Beta',
      db,
    });
    const atendenteB = await createUser({
      tenantId: outro.id,
      role: 'attendant',
      name: 'Atendente Beta',
      db,
    });
    const convB = await seedConversation({
      tenantId: outro.id,
      ageSeconds: 40 * 3600,
      patientName: 'Paciente do Beta',
    });
    const pendenteB = await createProposal({
      tenantId: outro.id,
      conversationId: convB,
      createdBy: atendenteB.id,
      approvalStatus: 'pending',
      totalPrice: 99,
      db,
    });

    const resA = await app.agent.get(URL).set(app.auth(manager)).expect(200);
    const jsonA = JSON.stringify(resA.body);
    expect(jsonA).not.toContain('Paciente do Beta');
    expect(jsonA).not.toContain('Atendente Beta');
    expect(jsonA).not.toContain(pendenteB.id);
    expect(resA.body.queue.unassigned).toBe(2);
    expect(resA.body.pendingDecisions.total).toBe(2);
    // A espera de 40h do Beta nao pode virar o "mais antigo" de A.
    inRange(resA.body.queue.oldestWaitSeconds, 3 * 3600);

    const resB = await app.agent.get(URL).set(app.auth(managerB)).expect(200);
    const jsonB = JSON.stringify(resB.body);
    expect(jsonB).not.toContain('Joao Santos');
    expect(jsonB).not.toContain('Ana Souza');
    expect(resB.body.queue.unassigned).toBe(1);
    expect(resB.body.queue.waiting).toBe(0);
    expect(resB.body.pendingDecisions.total).toBe(1);
    expect(resB.body.workload.map((w: { name: string }) => w.name)).toEqual([
      'Atendente Beta',
      'Gestor Beta',
    ]);
    void carla;
  });
});
