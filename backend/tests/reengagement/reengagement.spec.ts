/**
 * Reingajamento da conversa (CRMLAB-62, D-211..D-214). SERVICES.md §28.
 *
 * Banco real (PGlite), envio pelo MessageService de verdade com um gateway
 * falso, relogio SEMPRE injetado: as mensagens sao gravadas com `created_at`
 * explicito e o motor recebe `now`. Horario de funcionamento: seg-sex 8-18.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateFunnelRulesRequest } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { MemoryCache } from '../../src/lib/cache.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createFunnelRulesService } from '../../src/services/funnel-rules.service.js';
import {
  createFunnelTimerService,
  resetFunnelTimerLocksForTest,
} from '../../src/services/funnel-timer.service.js';
import { MessageService } from '../../src/services/message.service.js';
import {
  createReengagementService,
  type ReengagementService,
} from '../../src/services/reengagement.service.js';
import type { WhatsAppService } from '../../src/services/whatsapp.service.js';
import {
  createConversation,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { ctxOf } from '../proposals/support.js';

const HOUR = 60 * 60 * 1000;

/** `YYYY-MM-DDTHH:MM` em Brasilia -> instante. Segunda 28/09/2026. */
function brt(local: string): Date {
  return new Date(`${local}:00.000-03:00`);
}

let db: DbClient;
let ws: FakeWsHub;
let tenant: TenantRecord;
let admin: UserRecord;
let agent: UserRecord;
let sent: { to: string; text: string }[];
let failSend: boolean;
let service: ReengagementService;

function fakeWhatsApp(): WhatsAppService {
  let n = 0;
  const fake = {
    send: async (_tenantId: string, to: string, text: string) => {
      if (failSend) throw new Error('gateway fora');
      sent.push({ to, text });
      n += 1;
      return { externalId: `EVO-${n}` };
    },
  };
  return fake as unknown as WhatsAppService;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  resetFunnelTimerLocksForTest();
  ws = new FakeWsHub();
  sent = [];
  failSend = false;
  tenant = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  admin = await createUser({ tenantId: tenant.id, role: 'admin', db });
  agent = await createUser({ tenantId: tenant.id, role: 'attendant', db });
  const messages = new MessageService({
    messages: new MessageRepository(db),
    conversations: new ConversationRepository(db),
    wsHub: ws,
    whatsapp: fakeWhatsApp(),
  });
  service = createReengagementService({ db, sender: messages });
  await channel(tenant.id, 'qr');
  await businessHours(tenant.id, {
    timezone: 'America/Sao_Paulo',
    days: {
      mon: { start: '08:00', end: '18:00' },
      tue: { start: '08:00', end: '18:00' },
      wed: { start: '08:00', end: '18:00' },
      thu: { start: '08:00', end: '18:00' },
      fri: { start: '08:00', end: '18:00' },
    },
  });
  await setRules({ reengagement: { first: { enabled: true, hours: 1 } } });
});

async function setRules(patch: UpdateFunnelRulesRequest): Promise<void> {
  const rules = createFunnelRulesService({ db, audit: createAuditService(db) });
  await rules.update(ctxOf({ ...admin, discountLimit: 100 }), patch);
}

async function channel(tenantId: string, mode: 'qr' | 'cloud_api', active = true): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode)
       VALUES ($1, 'whatsapp', $2, $3)
       ON CONFLICT (tenant_id, channel) DO UPDATE SET is_active = $2, connection_mode = $3`,
      [tenantId, active, mode],
    ),
  );
}

async function businessHours(tenantId: string, hours: unknown): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, business_hours) VALUES ($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET business_hours = $2::jsonb`,
      [tenantId, JSON.stringify(hours)],
    ),
  );
}

type Sender = 'patient' | 'agent' | 'phone';

async function say(conversationId: string, who: Sender, at: Date, tenantId = tenant.id): Promise<string> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, sender_type, sender_id, content, status, created_at)
       VALUES ($1, $2, $3, $4, 'oi', 'sent', $5::timestamp) RETURNING id`,
      [
        tenantId,
        conversationId,
        who === 'patient' ? 'patient' : 'agent',
        who === 'agent' ? agent.id : null,
        at.toISOString(),
      ],
    ),
  );
  await db.withoutTenant((tx) =>
    tx.query('UPDATE conversations SET last_message_at = $2::timestamp WHERE id = $1', [
      conversationId,
      at.toISOString(),
    ]),
  );
  return result.rows[0]?.id ?? '';
}

/** Conversa em que o paciente falou e a atendente respondeu em `answeredAt`. */
async function silence(answeredAt: Date, opts: { status?: 'active' | 'closed'; channel?: string } = {}) {
  const conversation = await createConversation({
    tenantId: tenant.id,
    status: opts.status ?? 'active',
    channel: opts.channel ?? 'whatsapp',
    db,
  });
  await say(conversation.id, 'patient', new Date(answeredAt.getTime() - 5 * 60 * 1000));
  const anchor = await say(conversation.id, 'agent', answeredAt);
  return { conversation, anchor };
}

async function decisions(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ step: string; outcome: string; reason: string | null; message_id: string | null }>(
      `SELECT step, outcome, reason, message_id FROM conversation_reengagements
        WHERE conversation_id = $1 ORDER BY step`,
      [conversationId],
    ),
  );
  return result.rows;
}

async function automatedMessages(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string; status: string; sender_id: string | null }>(
      `SELECT content, status, sender_id FROM messages
        WHERE conversation_id = $1 AND automation = 'reengagement' ORDER BY created_at`,
      [conversationId],
    ),
  );
  return result.rows;
}

describe('1º reingajamento', () => {
  it('sai 1h depois da ultima mensagem da atendente, uma vez so', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));

    expect(await service.runForTenant(tenant.id, brt('2026-09-28T10:59'))).toEqual({ sent: 0, discarded: 0, failed: 0 });
    expect(await service.runForTenant(tenant.id, brt('2026-09-28T11:00'))).toEqual({ sent: 1, discarded: 0, failed: 0 });
    // Tique seguinte nao manda de novo.
    expect(await service.runForTenant(tenant.id, brt('2026-09-28T11:05'))).toEqual({ sent: 0, discarded: 0, failed: 0 });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Passando para saber se ficou alguma dúvida');
    const rows = await automatedMessages(conversation.id);
    expect(rows).toEqual([expect.objectContaining({ status: 'sent', sender_id: null })]);
    expect(await decisions(conversation.id)).toEqual([
      expect.objectContaining({ step: 'first', outcome: 'sent', reason: null }),
    ]);
    expect(ws.eventsFor(tenant.id, 'conversation.new_message').length).toBeGreaterThan(0);
  });

  it('aparece como "Mensagem automática" na conversa', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    const page = await new MessageRepository(db).listByConversation(tenant.id, conversation.id, { page: 1, limit: 50 });
    expect(page).not.toBeNull();
    const last = page!.rows[page!.rows.length - 1];
    expect(last).toEqual(expect.objectContaining({ senderType: 'agent', senderId: null, senderName: 'Mensagem automática' }));
  });

  it('paciente que responde antes nao recebe', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await say(conversation.id, 'patient', brt('2026-09-28T10:30'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:30'));
    expect(sent).toHaveLength(0);
  });

  it('mensagem pelo celular (fromMe) conta como da atendente', async () => {
    const conversation = await createConversation({ tenantId: tenant.id, db });
    await say(conversation.id, 'patient', brt('2026-09-28T09:55'));
    await say(conversation.id, 'phone', brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent).toHaveLength(1);
  });

  it('conversa encerrada nunca recebe', async () => {
    await silence(brt('2026-09-28T10:00'), { status: 'closed' });
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent).toHaveLength(0);
  });

  it('canal na API oficial nunca recebe, com a regra ligada (D-214)', async () => {
    await channel(tenant.id, 'cloud_api');
    await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent).toHaveLength(0);
  });

  it('regra desligada: nada muda', async () => {
    await setRules({ reengagement: { first: { enabled: false } } });
    await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent).toHaveLength(0);
  });

  it('prazo vencido fora do horario sai na abertura, nao antes', async () => {
    await silence(brt('2026-09-28T17:30'));
    await service.runForTenant(tenant.id, brt('2026-09-28T19:00'));
    await service.runForTenant(tenant.id, brt('2026-09-29T07:55'));
    expect(sent).toHaveLength(0);
    await service.runForTenant(tenant.id, brt('2026-09-29T08:00'));
    expect(sent).toHaveLength(1);
  });

  it('paciente que responde entre o vencimento e a abertura nao recebe', async () => {
    const { conversation } = await silence(brt('2026-09-28T17:30'));
    await service.runForTenant(tenant.id, brt('2026-09-28T19:00'));
    await say(conversation.id, 'patient', brt('2026-09-28T22:00'));
    await service.runForTenant(tenant.id, brt('2026-09-29T08:00'));
    expect(sent).toHaveLength(0);
  });

  it('abertura em feriado do laboratorio: descarta e nao manda depois', async () => {
    const holidays = await import('../../src/services/holiday.service.js');
    const svc = holidays.createHolidayService({ db, audit: createAuditService(db) });
    await svc.create(ctxOf({ ...admin, discountLimit: 100 }), { date: '2026-09-29', description: 'Aniversário da cidade' });

    const { conversation } = await silence(brt('2026-09-28T17:30'));
    expect((await service.runForTenant(tenant.id, brt('2026-09-28T18:30'))).discarded).toBe(1);
    await service.runForTenant(tenant.id, brt('2026-09-29T08:00'));
    await service.runForTenant(tenant.id, brt('2026-09-30T08:00'));
    expect(sent).toHaveLength(0);
    expect(await decisions(conversation.id)).toEqual([
      expect.objectContaining({ step: 'first', outcome: 'discarded', reason: 'holiday' }),
    ]);
  });

  it('abertura em feriado nacional tambem descarta', async () => {
    // Quinta 19/11 17:30; abertura sexta 20/11 (Consciencia Negra).
    await silence(brt('2026-11-19T17:30'));
    const result = await service.runForTenant(tenant.id, brt('2026-11-19T18:40'));
    expect(result.discarded).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('canal sem horario configurado envia a qualquer hora', async () => {
    await businessHours(tenant.id, { timezone: 'America/Sao_Paulo', days: {} });
    await silence(brt('2026-10-03T22:00'));
    await service.runForTenant(tenant.id, brt('2026-10-03T23:00'));
    expect(sent).toHaveLength(1);
  });

  it('ligar a regra nao dispara para silencio antigo (stale)', async () => {
    const { conversation } = await silence(brt('2026-09-21T10:00'));
    const result = await service.runForTenant(tenant.id, brt('2026-09-28T10:00'));
    expect(result).toEqual({ sent: 0, discarded: 1, failed: 0 });
    expect(await decisions(conversation.id)).toEqual([
      expect.objectContaining({ outcome: 'discarded', reason: 'stale' }),
    ]);
  });

  it('silencio alem da janela de busca e simplesmente ignorado', async () => {
    const { conversation } = await silence(brt('2026-08-01T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T10:00'));
    expect(await decisions(conversation.id)).toEqual([]);
  });

  it('falha do canal fica failed e nao trava o resto', async () => {
    const a = await silence(brt('2026-09-28T10:00'));
    failSend = true;
    const result = await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(result).toEqual({ sent: 0, discarded: 0, failed: 1 });
    expect(await automatedMessages(a.conversation.id)).toEqual([expect.objectContaining({ status: 'failed' })]);
    const [row] = await decisions(a.conversation.id);
    expect(row).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(row?.message_id).not.toBeNull();
    // Nao tenta de novo no tique seguinte.
    failSend = false;
    await service.runForTenant(tenant.id, brt('2026-09-28T11:05'));
    expect(sent).toHaveLength(0);
  });

  it('dois tiques ao mesmo tempo mandam uma vez so', async () => {
    await silence(brt('2026-09-28T10:00'));
    await Promise.all([
      service.runForTenant(tenant.id, brt('2026-09-28T11:00')),
      service.runForTenant(tenant.id, brt('2026-09-28T11:00')),
    ]);
    expect(sent).toHaveLength(1);
  });

  it('nova mensagem da atendente abre um silencio novo', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    await say(conversation.id, 'patient', brt('2026-09-28T13:00'));
    await say(conversation.id, 'agent', brt('2026-09-28T13:10'));
    await service.runForTenant(tenant.id, brt('2026-09-28T14:10'));
    expect(sent).toHaveLength(2);
  });

  it('isolamento: laboratorio B nao entra no tique de A', async () => {
    const other = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
    const conv = await createConversation({ tenantId: other.id, db });
    await say(conv.id, 'patient', brt('2026-09-28T09:55'), other.id);
    await say(conv.id, 'agent', brt('2026-09-28T10:00'), other.id);
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent).toHaveLength(0);
  });
});

describe('2º reingajamento', () => {
  beforeEach(async () => {
    await setRules({ reengagement: { second: { enabled: true, hours: 24 } } });
  });

  it('sai Y horas depois do 1º se o paciente continuar calado; nunca um terceiro', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    await service.runForTenant(tenant.id, brt('2026-09-29T10:59'));
    expect(sent).toHaveLength(1);
    await service.runForTenant(tenant.id, brt('2026-09-29T11:00'));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('Como não tivemos retorno');
    await service.runForTenant(tenant.id, brt('2026-09-30T12:00'));
    await service.runForTenant(tenant.id, brt('2026-10-01T12:00'));
    expect(sent).toHaveLength(2);
    expect((await decisions(conversation.id)).map((d) => `${d.step}:${d.outcome}`)).toEqual([
      'first:sent',
      'second:sent',
    ]);
  });

  it('nao sai se o paciente respondeu depois do 1º', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    await say(conversation.id, 'patient', brt('2026-09-28T15:00'));
    await service.runForTenant(tenant.id, brt('2026-09-29T11:00'));
    expect(sent).toHaveLength(1);
  });

  it('a mensagem automatica nao vira ancora de um silencio novo', async () => {
    await setRules({ reengagement: { second: { enabled: false } } });
    await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T12:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T13:00'));
    expect(sent).toHaveLength(1);
  });
});

describe('dentro do motor de tempo (D-211 item 1)', () => {
  it('o tique do funil roda o reingajamento, mesmo sem proposta aberta', async () => {
    let clock = brt('2026-09-28T11:00');
    const timer = createFunnelTimerService({
      db,
      wsHub: ws,
      cache: new MemoryCache(),
      reengagement: service,
      now: () => clock,
    });
    await silence(brt('2026-09-28T10:00'));
    const tick = await timer.runTick();
    expect(tick.tenants).toEqual([expect.objectContaining({ tenantId: tenant.id, reengaged: 1 })]);
    clock = new Date(clock.getTime() + HOUR);
    await timer.runTick();
    expect(sent).toHaveLength(1);
  });

  it('laboratorio com a regra desligada e sem proposta nao entra no tique', async () => {
    await setRules({ reengagement: { first: { enabled: false } } });
    const timer = createFunnelTimerService({
      db,
      wsHub: ws,
      cache: new MemoryCache(),
      reengagement: service,
      now: () => brt('2026-09-28T11:00'),
    });
    expect((await timer.runTick()).tenants).toEqual([]);
  });
});

describe('variavel {paciente} na mensagem (CRMLAB-96, D-266)', () => {
  async function setContactName(conversationId: string, name: string | null): Promise<void> {
    await db.withoutTenant((tx) =>
      tx.query('UPDATE conversations SET patient_name = $2 WHERE id = $1', [conversationId, name]),
    );
  }

  async function linkPatient(conversationId: string, name: string | null): Promise<void> {
    await db.withoutTenant(async (tx) => {
      const patient = await tx.query<{ id: string }>(
        `INSERT INTO patients (tenant_id, phone, name) VALUES ($1, $2, $3) RETURNING id`,
        [tenant.id, `+55489${String(Date.now()).slice(-8)}`, name],
      );
      await tx.query('UPDATE conversations SET patient_id = $2 WHERE id = $1', [
        conversationId,
        patient.rows[0]?.id,
      ]);
    });
  }

  beforeEach(async () => {
    await setRules({ reengagement: { first: { message: 'Olá, {paciente}! Ficou alguma dúvida?' } } });
  });

  it('usa o primeiro nome da ficha vinculada, com capitalizacao normal', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await setContactName(conversation.id, 'Contato do WhatsApp');
    await linkPatient(conversation.id, 'MARIA DA SILVA');
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent.map((s) => s.text)).toEqual(['Olá, Maria! Ficou alguma dúvida?']);
    expect((await automatedMessages(conversation.id))[0]?.content).toBe('Olá, Maria! Ficou alguma dúvida?');
  });

  it('sem ficha (ou ficha sem nome), usa o nome do contato da conversa', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await setContactName(conversation.id, 'joão pedro');
    await linkPatient(conversation.id, null);
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent.map((s) => s.text)).toEqual(['Olá, João! Ficou alguma dúvida?']);
  });

  it('sem nome nenhum, a variavel some sem deixar sobra', async () => {
    const { conversation } = await silence(brt('2026-09-28T10:00'));
    await setContactName(conversation.id, null);
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent.map((s) => s.text)).toEqual(['Olá! Ficou alguma dúvida?']);
  });

  it('mensagem sem variavel sai igual', async () => {
    await setRules({ reengagement: { first: { message: 'Oi! Tudo certo por aí?' } } });
    await silence(brt('2026-09-28T10:00'));
    await service.runForTenant(tenant.id, brt('2026-09-28T11:00'));
    expect(sent.map((s) => s.text)).toEqual(['Oi! Tudo certo por aí?']);
  });
});
