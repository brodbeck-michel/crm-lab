/**
 * `GET /analytics/response-time` — relatório de tempo de resposta (CRMLAB-83,
 * D-257), API_CONTRACTS.md §5.
 *
 * Expediente dos cenários: seg–sex 08:00–18:00 em America/Sao_Paulo (UTC−3,
 * sem horário de verão). Os horários abaixo estão em UTC no banco e no
 * comentário vem a hora LOCAL. 2026-09-07 (seg) é feriado nacional.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ResponseTimeReport } from '@crm-lab/shared';
import { analyticsModule } from '../../src/controllers/analytics.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { bucketsOf, figuresOf } from '../../src/services/response-time.service.js';
import { createConversation, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/analytics/response-time';
const HOURS = {
  timezone: 'America/Sao_Paulo',
  days: {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: { start: '08:00', end: '18:00' },
    thu: { start: '08:00', end: '18:00' },
    fri: { start: '08:00', end: '18:00' },
    sat: null,
    sun: null,
  },
};

type Who = 'patient' | 'agent' | 'phone' | 'automation' | 'system';

interface Line {
  who: Who;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  at: string;
  by?: UserRecord;
  content?: string;
  /** Resposta de participante (D-263): a dona do momento. */
  attributedTo?: UserRecord;
}

let db: DbClient;
let app: TestApp;
let tenantId: string;
let manager: UserRecord;
let ana: UserRecord;
let bruno: UserRecord;

async function businessHours(id: string, hours: unknown = HOURS): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, business_hours) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET business_hours = $2::jsonb`,
      [id, JSON.stringify(hours)],
    ),
  );
}

async function holiday(id: string, date: string): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(`INSERT INTO tenant_holidays (tenant_id, holiday_date, description) VALUES ($1, $2::date, 'Teste')`, [
      id,
      date,
    ]),
  );
}

/** Uma conversa com as mensagens na ordem dada. Devolve o id da conversa. */
async function talk(lines: Line[], opts: { tenant?: string; status?: 'active' | 'closed' } = {}): Promise<string> {
  const tid = opts.tenant ?? tenantId;
  const conversation = await createConversation({ tenantId: tid, status: opts.status ?? 'active', db });
  await db.withoutTenant(async (tx) => {
    for (const line of lines) {
      const senderType = line.who === 'patient' ? 'patient' : line.who === 'system' ? 'system' : 'agent';
      await tx.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                               message_type, status, automation, created_at, attributed_to)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 'delivered', $7, $8::timestamp, $9)`,
        [
          randomUUID(),
          tid,
          conversation.id,
          senderType,
          line.who === 'agent' ? (line.by ?? ana).id : null,
          line.content ?? 'oi',
          line.who === 'automation' ? 'reengagement' : null,
          line.at,
          line.attributedTo?.id ?? null,
        ],
      );
    }
  });
  return conversation.id;
}

async function report(
  query = '?startDate=2026-09-01&endDate=2026-09-30',
  user: UserRecord = manager,
): Promise<ResponseTimeReport> {
  const res = await app.agent.get(`${URL}${query}`).set(app.auth(user)).expect(200);
  return res.body as ResponseTimeReport;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [analyticsModule] });
  tenantId = (await createTenant({ db })).id;
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora', db });
  ana = await createUser({ tenantId, role: 'attendant', name: 'Ana', db });
  bruno = await createUser({ tenantId, role: 'attendant', name: 'Bruno', db });
  await businessHours(tenantId);
});

describe('aritmética', () => {
  it('mediana com quantidade par é a média dos dois do meio; vazio é null', () => {
    expect(figuresOf([10, 3])).toEqual({ answered: 2, averageMinutes: 6.5, medianMinutes: 6.5 });
    expect(figuresOf([1, 2, 30])).toEqual({ answered: 3, averageMinutes: 11, medianMinutes: 2 });
    expect(figuresOf([])).toEqual({ answered: 0, averageMinutes: null, medianMinutes: null });
  });

  it('faixas inclusivas: 5 | 6–15 | 16–60 | 61+', () => {
    expect(bucketsOf([0, 5, 6, 15, 16, 60, 61])).toEqual({ upTo5: 2, upTo15: 2, upTo60: 2, over60: 1 });
  });
});

describe('GET /analytics/response-time', () => {
  it('bloco com várias mensagens conta da PRIMEIRA; a abertura entra na primeira resposta', async () => {
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' }, // ter 09:00
      { who: 'patient', at: '2026-09-15 12:04:00' },
      { who: 'patient', at: '2026-09-15 12:08:00' },
      { who: 'agent', by: ana, at: '2026-09-15 12:10:00' }, // 10 min
      { who: 'patient', at: '2026-09-15 13:00:00' }, // 10:00, bloco 2
      { who: 'agent', by: ana, at: '2026-09-15 13:03:00' }, // 3 min
    ]);

    const r = await report();
    expect(r.timezone).toBe('America/Sao_Paulo');
    expect(r.total).toMatchObject({ answered: 2, averageMinutes: 6.5, medianMinutes: 6.5 });
    expect(r.total.firstResponse).toEqual({ answered: 1, averageMinutes: 10, medianMinutes: 10 });
    expect(r.total.buckets).toEqual({ upTo5: 1, upTo15: 1, upTo60: 0, over60: 0 });
    expect(r.responders).toHaveLength(1);
    expect(r.responders[0]).toMatchObject({ responderId: ana.id, name: 'Ana', kind: 'user', answered: 2 });
    const day = r.total.daily.find((d) => d.date === '2026-09-15');
    expect(day).toMatchObject({ answered: 2, medianMinutes: 6.5, unanswered: 0 });
    expect(r.total.daily).toHaveLength(30);
  });

  it('automática e sistema no meio não respondem nem encerram a espera', async () => {
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' }, // 09:00
      { who: 'automation', at: '2026-09-15 12:30:00' },
      { who: 'system', at: '2026-09-15 12:40:00', content: 'Conversa transferida para Bruno' },
      { who: 'patient', at: '2026-09-15 12:50:00' }, // mesmo bloco
      { who: 'agent', by: bruno, at: '2026-09-15 13:30:00' }, // 10:30 → 90 min
    ]);

    const r = await report();
    expect(r.total).toMatchObject({ answered: 1, medianMinutes: 90 });
    expect(r.total.buckets.over60).toBe(1);
    expect(r.responders.map((x) => x.name)).toEqual(['Bruno']);
  });

  it('resposta pelo celular vira a linha "Celular"; ranking pela mediana', async () => {
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' },
      { who: 'phone', at: '2026-09-15 12:20:00' }, // 20 min
    ]);
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' },
      { who: 'agent', by: ana, at: '2026-09-15 12:02:00' }, // 2 min
    ]);

    const r = await report();
    expect(r.responders.map((x) => [x.name, x.kind, x.medianMinutes])).toEqual([
      ['Ana', 'user', 2],
      ['Celular', 'phone', 20],
    ]);
    expect(r.responders[1]?.responderId).toBe('phone');
    expect(r.total).toMatchObject({ answered: 2, medianMinutes: 11 });
  });

  it('resposta de participante conta para a dona do momento (D-263 item 6)', async () => {
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' },
      // A gestora participante respondeu na conversa da Ana.
      { who: 'agent', by: manager, attributedTo: ana, at: '2026-09-15 12:04:00' },
    ]);

    const r = await report();
    expect(r.responders.map((x) => [x.name, x.medianMinutes])).toEqual([['Ana', 4]]);
  });

  it('fora do expediente: conta só a partir da abertura', async () => {
    await talk([
      { who: 'patient', at: '2026-09-15 23:00:00' }, // ter 20:00 (fechado)
      { who: 'agent', by: ana, at: '2026-09-16 11:07:00' }, // qua 08:07 → 7 min
    ]);
    const r = await report();
    expect(r.total.medianMinutes).toBe(7);
    // O bloco é do dia LOCAL em que o paciente escreveu.
    expect(r.total.daily.find((d) => d.date === '2026-09-15')?.answered).toBe(1);
  });

  it('feriado nacional e feriado do laboratório não contam', async () => {
    await holiday(tenantId, '2026-09-16');
    await talk([
      { who: 'patient', at: '2026-09-04 20:50:00' }, // sex 17:50 → 10 min na sexta
      { who: 'agent', by: ana, at: '2026-09-08 11:05:00' }, // seg 07/09 feriado; ter 08:05 → +5
    ]);
    await talk([
      { who: 'patient', at: '2026-09-15 20:00:00' }, // ter 17:00 → 60 min
      { who: 'agent', by: ana, at: '2026-09-17 11:30:00' }, // qua 16/09 cadastrado; qui 08:30 → +30
    ]);
    const r = await report();
    expect(r.responders[0]?.daily.find((d) => d.date === '2026-09-04')?.medianMinutes).toBe(15);
    expect(r.responders[0]?.daily.find((d) => d.date === '2026-09-15')?.medianMinutes).toBe(90);
  });

  it('laboratório sem expediente configurado = sempre aberto', async () => {
    await businessHours(tenantId, { timezone: 'America/Sao_Paulo', days: {} });
    await talk([
      { who: 'patient', at: '2026-09-19 02:00:00' }, // sáb 23:00
      { who: 'agent', by: ana, at: '2026-09-19 02:45:00' },
    ]);
    expect((await report()).total.medianMinutes).toBe(45);
  });

  it('sem resposta: aguardando, encerrada sem resposta e o "obrigado" antes de encerrar', async () => {
    await talk([{ who: 'patient', at: '2026-09-15 12:00:00' }]); // aguardando
    await talk(
      [
        { who: 'patient', at: '2026-09-15 12:00:00' },
        { who: 'agent', by: ana, at: '2026-09-15 12:05:00' },
        { who: 'patient', at: '2026-09-15 12:06:00', content: 'obrigado' }, // encerrada sem resposta
        { who: 'system', at: '2026-09-15 12:07:00', content: 'Atendimento encerrado por Ana' },
        { who: 'system', at: '2026-09-22 12:00:00', content: 'Atendimento reaberto pelo paciente' },
        { who: 'patient', at: '2026-09-22 12:00:01' }, // volta: abre o atendimento
        { who: 'agent', by: bruno, at: '2026-09-22 12:04:01' }, // 4 min
      ],
      { status: 'active' },
    );
    // Encerrada antiga, sem evento de sistema: o status decide.
    await talk([{ who: 'patient', at: '2026-09-16 12:00:00' }], { status: 'closed' });

    const r = await report();
    expect(r.total.unanswered).toEqual({ waiting: 1, closed: 2, conversations: 3 });
    expect(r.total).toMatchObject({ answered: 2 });
    expect(r.total.firstResponse).toEqual({ answered: 2, averageMinutes: 4.5, medianMinutes: 4.5 });
    const bruno22 = r.responders.find((x) => x.name === 'Bruno');
    expect(bruno22).toMatchObject({ answered: 1, medianMinutes: 4 });
    expect(r.total.daily.find((d) => d.date === '2026-09-15')?.unanswered).toBe(2);
  });

  it('bloco começado antes do período não entra; resposta depois do fim entra', async () => {
    await talk([
      { who: 'patient', at: '2026-08-31 20:00:00' }, // seg 31/08 17:00 — fora do período
      { who: 'patient', at: '2026-09-01 12:00:00' }, // continuação do bloco
      { who: 'agent', by: ana, at: '2026-09-01 12:30:00' },
    ]);
    await talk([
      { who: 'patient', at: '2026-10-01 02:30:00' }, // 30/09 23:30 local → dia 30
      { who: 'agent', by: ana, at: '2026-10-01 11:10:00' }, // qui 08:10 → 10 min
    ]);
    const r = await report();
    expect(r.total.answered).toBe(1);
    expect(r.total.daily.find((d) => d.date === '2026-09-30')?.medianMinutes).toBe(10);
  });

  it('isolamento: o relatório de A não vê blocos nem atendentes de B', async () => {
    const tenantB = (await createTenant({ db })).id;
    const managerB = await createUser({ tenantId: tenantB, role: 'manager', db });
    const carla = await createUser({ tenantId: tenantB, role: 'attendant', name: 'Carla', db });
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' },
      { who: 'agent', by: carla, at: '2026-09-15 12:40:00' },
    ], { tenant: tenantB });
    await talk([
      { who: 'patient', at: '2026-09-15 12:00:00' },
      { who: 'agent', by: ana, at: '2026-09-15 12:01:00' },
    ]);

    const a = await report();
    expect(a.responders.map((x) => x.name)).toEqual(['Ana']);
    expect(a.total.answered).toBe(1);

    const b = await report(undefined, managerB);
    expect(b.responders.map((x) => x.name)).toEqual(['Carla']);
    expect(b.total.unanswered.waiting).toBe(0);
  });

  it('atendente e operador da plataforma recebem FORBIDDEN', async () => {
    const res = await app.agent.get(URL).set(app.auth(ana)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const operador = { ...manager, role: 'platform_operator' as const };
    await app.agent.get(URL).set(app.auth(operador)).expect(403);
  });

  it('admin lê; período acima de 93 dias ou invertido é VALIDATION_ERROR', async () => {
    const admin = await createUser({ tenantId, role: 'admin', db });
    await report('?startDate=2026-07-01&endDate=2026-10-01', admin); // 93 dias
    const longo = await app.agent
      .get(`${URL}?startDate=2026-07-01&endDate=2026-10-02`)
      .set(app.auth(manager))
      .expect(400);
    expect(longo.body.error.code).toBe('VALIDATION_ERROR');
    expect(longo.body.error.details.fields.endDate).toMatch(/93 dias/);
    await app.agent.get(`${URL}?startDate=2026-09-10&endDate=2026-09-01`).set(app.auth(manager)).expect(400);
  });
});
