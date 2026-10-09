/**
 * Resposta automatica fora do horario e boas-vindas (CRMLAB-94, D-264).
 * SERVICES.md §33, SCHEMA.md §40.
 *
 * Banco real (PGlite), envio pelo MessageService de verdade com um gateway
 * falso. A mensagem do paciente e gravada com `created_at` explicito e o
 * servico e chamado direto com ela — o relogio e sempre o da mensagem.
 * Horario de funcionamento: seg-sex 8-18 (Brasilia).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { offHoursReopening, type BusinessHours } from '@crm-lab/shared';
import type { DbClient } from '../../src/db/types.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import * as reengagementRepo from '../../src/repositories/reengagement.repository.js';
import {
  createAutoReplyService,
  type AutoReplyService,
} from '../../src/services/auto-reply.service.js';
import { MessageService } from '../../src/services/message.service.js';
import type { WhatsAppService } from '../../src/services/whatsapp.service.js';
import {
  createConversation,
  createTenant,
  type ConversationRecord,
  type TenantRecord,
} from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

/** `YYYY-MM-DDTHH:MM` em Brasilia -> instante. Segunda 28/09/2026. */
function brt(local: string): Date {
  return new Date(`${local}:00.000-03:00`);
}

const WEEKDAYS_8_18: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  days: {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: { start: '08:00', end: '18:00' },
    thu: { start: '08:00', end: '18:00' },
    fri: { start: '08:00', end: '18:00' },
  },
};

const OFFHOURS_TEXT = 'Estamos fora do horário. Respondemos a partir das 8h.';
const GREETING_TEXT = 'Olá! Recebemos sua mensagem.';

describe('offHoursReopening (puro)', () => {
  const none = new Set<string>();

  it('aberto = null', () => {
    expect(offHoursReopening(brt('2026-09-28T10:00'), WEEKDAYS_8_18, none)).toBeNull();
    expect(offHoursReopening(brt('2026-09-28T08:00'), WEEKDAYS_8_18, none)).toBeNull();
  });

  it('a noite inteira tem a mesma reabertura', () => {
    const tuesday8 = brt('2026-09-29T08:00');
    expect(offHoursReopening(brt('2026-09-28T18:00'), WEEKDAYS_8_18, none)).toEqual(tuesday8);
    expect(offHoursReopening(brt('2026-09-28T22:00'), WEEKDAYS_8_18, none)).toEqual(tuesday8);
    expect(offHoursReopening(brt('2026-09-29T03:00'), WEEKDAYS_8_18, none)).toEqual(tuesday8);
    expect(offHoursReopening(brt('2026-09-29T07:59'), WEEKDAYS_8_18, none)).toEqual(tuesday8);
  });

  it('fim de semana emendado com feriado nacional e um periodo so', () => {
    // Sex 09/10 -> seg 12/10 e Nossa Senhora Aparecida -> reabre ter 13/10.
    const reopening = brt('2026-10-13T08:00');
    expect(offHoursReopening(brt('2026-10-09T19:00'), WEEKDAYS_8_18, none)).toEqual(reopening);
    expect(offHoursReopening(brt('2026-10-11T15:00'), WEEKDAYS_8_18, none)).toEqual(reopening);
    // Dentro da faixa, mas feriado: fechado.
    expect(offHoursReopening(brt('2026-10-12T10:00'), WEEKDAYS_8_18, none)).toEqual(reopening);
  });

  it('feriado do laboratorio pula o dia', () => {
    const custom = new Set(['2026-09-29']);
    expect(offHoursReopening(brt('2026-09-28T22:00'), WEEKDAYS_8_18, custom)).toEqual(brt('2026-09-30T08:00'));
    expect(offHoursReopening(brt('2026-09-29T10:00'), WEEKDAYS_8_18, custom)).toEqual(brt('2026-09-30T08:00'));
  });

  it('sem nenhum dia configurado = sempre aberto, inclusive em feriado', () => {
    const empty: BusinessHours = { timezone: 'America/Sao_Paulo', days: {} };
    expect(offHoursReopening(brt('2026-09-28T23:00'), empty, none)).toBeNull();
    expect(offHoursReopening(brt('2026-10-12T10:00'), empty, none)).toBeNull();
  });
});

let db: DbClient;
let ws: FakeWsHub;
let tenant: TenantRecord;
let sent: { to: string; text: string }[];
let failSend: boolean;
let messages: MessageService;
let service: AutoReplyService;

function fakeWhatsApp(): WhatsAppService {
  let n = 0;
  const fake = {
    send: async (_tenantId: string, to: string, text: string) => {
      if (failSend) throw new Error('gateway fora');
      sent.push({ to, text });
      n += 1;
      return { externalId: `EVO-AUTO-${n}` };
    },
  };
  return fake as unknown as WhatsAppService;
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

async function settings(
  tenantId: string,
  input: { offHours?: boolean; greeting?: boolean; hours?: BusinessHours },
): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_settings (tenant_id, offhours_enabled, offhours_message,
                                    greeting_enabled, greeting_message, business_hours)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET
         offhours_enabled = $2, offhours_message = $3,
         greeting_enabled = $4, greeting_message = $5, business_hours = $6::jsonb`,
      [
        tenantId,
        input.offHours ?? false,
        OFFHOURS_TEXT,
        input.greeting ?? false,
        GREETING_TEXT,
        JSON.stringify(input.hours ?? WEEKDAYS_8_18),
      ],
    ),
  );
}

/** Mensagem do paciente em `at`; devolve o que o gancho recebe. */
async function patientSays(
  conversationId: string,
  at: Date,
  tenantId = tenant.id,
): Promise<{ id: string; createdAt: string }> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, sender_type, content, status, created_at)
       VALUES ($1, $2, 'patient', 'oi', 'delivered', $3::timestamp) RETURNING id`,
      [tenantId, conversationId, at.toISOString()],
    ),
  );
  return { id: result.rows[0]?.id ?? '', createdAt: at.toISOString() };
}

async function newConversation(opts: { status?: 'active' | 'closed'; channel?: string } = {}) {
  return createConversation({
    tenantId: tenant.id,
    status: opts.status ?? 'active',
    channel: opts.channel ?? 'whatsapp',
    db,
  });
}

async function automated(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ content: string; status: string; sender_id: string | null; automation: string }>(
      `SELECT content, status, sender_id, automation FROM messages
        WHERE conversation_id = $1 AND automation IS NOT NULL ORDER BY created_at`,
      [conversationId],
    ),
  );
  return result.rows;
}

async function replies(conversationId: string) {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ kind: string; outcome: string; message_id: string | null }>(
      `SELECT kind, outcome, message_id FROM conversation_auto_replies
        WHERE conversation_id = $1 ORDER BY decided_at`,
      [conversationId],
    ),
  );
  return result.rows;
}

async function reply(conversation: ConversationRecord, at: Date) {
  return service.afterPatientMessage(tenant.id, conversation.id, await patientSays(conversation.id, at), messages);
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  ws = new FakeWsHub();
  sent = [];
  failSend = false;
  tenant = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  messages = new MessageService({
    messages: new MessageRepository(db),
    conversations: new ConversationRepository(db),
    wsHub: ws,
    whatsapp: fakeWhatsApp(),
  });
  service = createAutoReplyService({ db });
  await channel(tenant.id, 'qr');
  await settings(tenant.id, { offHours: true });
});

describe('fora do horario', () => {
  it('fechado: responde com o texto configurado, como mensagem automatica', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T22:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });

    expect(sent).toEqual([{ to: conversation.patientPhone, text: OFFHOURS_TEXT }]);
    expect(await automated(conversation.id)).toEqual([
      { content: OFFHOURS_TEXT, status: 'sent', sender_id: null, automation: 'offhours' },
    ]);
    expect(await replies(conversation.id)).toEqual([
      expect.objectContaining({ kind: 'offhours', outcome: 'sent', message_id: expect.any(String) }),
    ]);
  });

  it('dentro do horario: nada', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T10:00'))).toBeNull();
    expect(sent).toEqual([]);
    expect(await replies(conversation.id)).toEqual([]);
  });

  it('feriado nacional dentro da faixa: responde', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-10-12T10:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });
    expect(sent).toHaveLength(1);
  });

  it('feriado do laboratorio dentro da faixa: responde', async () => {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_holidays (tenant_id, holiday_date, description) VALUES ($1, '2026-09-29', 'Aniversario')`,
        [tenant.id],
      ),
    );
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-29T10:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });
  });

  it('varias mensagens no mesmo periodo = uma resposta; periodo novo = resposta nova', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T19:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });
    expect(await reply(conversation, brt('2026-09-28T23:30'))).toBeNull();
    expect(await reply(conversation, brt('2026-09-29T06:00'))).toBeNull();
    expect(sent).toHaveLength(1);

    // Terca 10h: aberto. Terca 20h: periodo novo.
    expect(await reply(conversation, brt('2026-09-29T10:00'))).toBeNull();
    expect(await reply(conversation, brt('2026-09-29T20:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });
    expect(sent).toHaveLength(2);
    expect(await replies(conversation.id)).toHaveLength(2);
  });

  it('webhooks concorrentes no mesmo periodo: um envio so', async () => {
    const conversation = await newConversation();
    const first = await patientSays(conversation.id, brt('2026-09-28T22:00'));
    const second = await patientSays(conversation.id, brt('2026-09-28T22:00'));
    const results = await Promise.all([
      service.afterPatientMessage(tenant.id, conversation.id, first, messages),
      service.afterPatientMessage(tenant.id, conversation.id, second, messages),
    ]);
    expect(results.filter((r) => r !== null)).toEqual([{ kind: 'offhours', outcome: 'sent' }]);
    expect(sent).toHaveLength(1);
  });

  it('periodo e por conversa', async () => {
    const a = await newConversation();
    const b = await newConversation();
    await reply(a, brt('2026-09-28T22:00'));
    await reply(b, brt('2026-09-28T22:05'));
    expect(sent).toHaveLength(2);
  });

  it('desligada: nada', async () => {
    await settings(tenant.id, { offHours: false });
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T22:00'))).toBeNull();
    expect(sent).toEqual([]);
  });

  it('sem nenhum dia de expediente: nunca responde', async () => {
    await settings(tenant.id, { offHours: true, hours: { timezone: 'America/Sao_Paulo', days: {} } });
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T23:00'))).toBeNull();
    expect(sent).toEqual([]);
  });

  it('canal que nao envia (API oficial, inativo, conversa de outro canal): nada', async () => {
    const conversation = await newConversation();
    await channel(tenant.id, 'cloud_api');
    expect(await reply(conversation, brt('2026-09-28T22:00'))).toBeNull();
    await channel(tenant.id, 'qr', false);
    expect(await reply(conversation, brt('2026-09-28T22:10'))).toBeNull();

    await channel(tenant.id, 'qr');
    const web = await newConversation({ channel: 'web' });
    expect(await reply(web, brt('2026-09-28T22:20'))).toBeNull();
    expect(sent).toEqual([]);
    expect(await replies(web.id)).toEqual([]);
  });

  it('falha no envio: registra failed, nao derruba e nao reenvia no mesmo periodo', async () => {
    failSend = true;
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T22:00'))).toEqual({ kind: 'offhours', outcome: 'failed' });
    expect(await automated(conversation.id)).toEqual([expect.objectContaining({ status: 'failed', automation: 'offhours' })]);
    expect(await replies(conversation.id)).toEqual([
      expect.objectContaining({ kind: 'offhours', outcome: 'failed', message_id: expect.any(String) }),
    ]);

    failSend = false;
    expect(await reply(conversation, brt('2026-09-28T23:00'))).toBeNull();
    expect(sent).toEqual([]);
  });

  it('erro inesperado (sender que lanca erro qualquer) nunca escapa', async () => {
    const conversation = await newConversation();
    const broken = { createAutomated: () => Promise.reject(new Error('boom')) };
    await expect(
      service.afterPatientMessage(tenant.id, conversation.id, await patientSays(conversation.id, brt('2026-09-28T22:00')), broken),
    ).resolves.toEqual({ kind: 'offhours', outcome: 'failed' });
  });

  it('multitenant: conversa de outro laboratorio nao e reservada nem enviada', async () => {
    const other = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
    await channel(other.id, 'qr');
    await settings(other.id, { offHours: true });
    const conversation = await newConversation();
    const message = await patientSays(conversation.id, brt('2026-09-28T22:00'));
    expect(await service.afterPatientMessage(other.id, conversation.id, message, messages)).toBeNull();
    expect(sent).toEqual([]);
    expect(await replies(conversation.id)).toEqual([]);
  });

  it('a resposta automatica nao vira ancora do reingajamento', async () => {
    const conversation = await newConversation();
    await reply(conversation, brt('2026-09-28T22:00'));
    const silences = await db.withTenant(tenant.id, (tx) =>
      reengagementRepo.selectSilences(tx, tenant.id, brt('2026-09-20T00:00'), 10),
    );
    expect(silences).toEqual([]);
  });
});

describe('boas-vindas', () => {
  beforeEach(async () => {
    await settings(tenant.id, { offHours: true, greeting: true });
  });

  it('primeira mensagem com o laboratorio aberto: boas-vindas, uma vez', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T10:00'))).toEqual({ kind: 'greeting', outcome: 'sent' });
    expect(await reply(conversation, brt('2026-09-28T10:05'))).toBeNull();
    expect(sent).toEqual([{ to: conversation.patientPhone, text: GREETING_TEXT }]);
    expect(await automated(conversation.id)).toEqual([expect.objectContaining({ automation: 'greeting' })]);
  });

  it('primeira mensagem com o laboratorio fechado: so a de fora do horario', async () => {
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T22:00'))).toEqual({ kind: 'offhours', outcome: 'sent' });
    // De manha ja nao e a primeira mensagem.
    expect(await reply(conversation, brt('2026-09-29T09:00'))).toBeNull();
    expect(sent.map((s) => s.text)).toEqual([OFFHOURS_TEXT]);
  });

  it('conversa que ja tinha mensagem: sem boas-vindas', async () => {
    const conversation = await newConversation();
    await patientSays(conversation.id, brt('2026-09-20T10:00'));
    expect(await reply(conversation, brt('2026-09-28T10:00'))).toBeNull();
    expect(sent).toEqual([]);
  });

  it('desligada: nada', async () => {
    await settings(tenant.id, { offHours: true, greeting: false });
    const conversation = await newConversation();
    expect(await reply(conversation, brt('2026-09-28T10:00'))).toBeNull();
  });
});

describe('gancho em MessageService.createFromPatient', () => {
  it('chama o servico so para mensagem NOVA (reentrega deduplicada nao)', async () => {
    const afterPatientMessage = vi.fn(async () => null);
    const hooked = new MessageService({
      messages: new MessageRepository(db),
      conversations: new ConversationRepository(db),
      wsHub: ws,
      autoReply: { afterPatientMessage },
    });
    const conversation = await newConversation();
    const message = await hooked.createFromPatient(tenant.id, conversation.id, { content: 'oi', externalId: 'EXT-1' });
    await hooked.createFromPatient(tenant.id, conversation.id, { content: 'oi', externalId: 'EXT-1' });

    expect(afterPatientMessage).toHaveBeenCalledTimes(1);
    expect(afterPatientMessage).toHaveBeenCalledWith(tenant.id, conversation.id, message, hooked);
  });

  it('servico que demora ou falha nao segura nem derruba a mensagem do paciente', async () => {
    let release: () => void = () => undefined;
    const afterPatientMessage = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    );
    const hooked = new MessageService({
      messages: new MessageRepository(db),
      conversations: new ConversationRepository(db),
      wsHub: ws,
      autoReply: { afterPatientMessage },
    });
    const conversation = await newConversation();
    const message = await hooked.createFromPatient(tenant.id, conversation.id, { content: 'oi' });
    expect(message.senderType).toBe('patient');
    release();
  });

  it('ponta a ponta: a primeira mensagem do paciente recebe as boas-vindas pelo canal', async () => {
    // Sem dia configurado = sempre aberto: o relogio real nao importa.
    await settings(tenant.id, {
      offHours: true,
      greeting: true,
      hours: { timezone: 'America/Sao_Paulo', days: {} },
    });
    const hooked = new MessageService({
      messages: new MessageRepository(db),
      conversations: new ConversationRepository(db),
      wsHub: ws,
      whatsapp: fakeWhatsApp(),
      autoReply: service,
    });
    const conversation = await newConversation();
    await hooked.createFromPatient(tenant.id, conversation.id, { content: 'oi', externalId: 'EXT-2' });
    await vi.waitFor(async () => {
      expect(await automated(conversation.id)).toEqual([
        expect.objectContaining({ automation: 'greeting', status: 'sent' }),
      ]);
    });
    expect(sent).toEqual([{ to: conversation.patientPhone, text: GREETING_TEXT }]);
  });
});
