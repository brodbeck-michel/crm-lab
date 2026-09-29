/**
 * Webhook do Evolution — tiques e presença (CRMLAB-67, D-225/D-226).
 * Payloads na forma do Evolution v2:
 *
 * - `messages.update`: `data = { keyId, remoteJid, fromMe, participant, status, instanceId }`,
 *   `status` texto de `renderStatus.ts` (ERROR, PENDING, SERVER_ACK, DELIVERY_ACK, READ,
 *   PLAYED) — ou o número 0..5;
 * - `presence.update`: o payload cru do Baileys,
 *   `data = { id: '<jid>', presences: { '<jid>': { lastKnownPresence, lastSeen? } } }`.
 *
 * O que mais importa: ack fora de ordem NUNCA rebaixa, e presença não grava nada
 * e só vai para a room do próprio laboratório.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { EVOLUTION_WEBHOOK_EVENTS, evolutionInstanceName } from '../../src/lib/evolution-client.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { seedMessage } from '../conversations/helpers.js';
import { createConversation, createTenant, type TenantRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const TOKEN = 'segredo-do-gateway-crmlab67';
const WEBHOOK = '/api/v1/webhooks/evolution';
const PATIENT_PHONE = '5548999991234';
const PATIENT_JID = `${PATIENT_PHONE}@s.whatsapp.net`;

let db: DbClient;
let app: TestApp;
let messages: MessageRepository;
const slugToId = new Map<string, string>();

function resolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: '',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'qr',
    qrInstanceApiKey: null,
  });
  return {
    forTenant: async (tenantId) => build(tenantId),
    byWebhookIdentity: async (identity) => {
      const tenantId = slugToId.get(identity);
      return tenantId ? build(tenantId) : null;
    },
  };
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
  messages = new MessageRepository(db);
});

afterEach(() => {
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
});

async function lab(slug: string): Promise<{ tenant: TenantRecord; conversationId: string }> {
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  const conversation = await createConversation({
    tenantId: tenant.id,
    patientPhone: `+${PATIENT_PHONE}`,
  });
  return { tenant, conversationId: conversation.id };
}

function post(slug: string, tenant: TenantRecord, event: string, data: unknown, instance?: string) {
  return app.agent
    .post(`${WEBHOOK}/${slug}`)
    .set('x-evolution-webhook-token', TOKEN)
    .send({ event, instance: instance ?? evolutionInstanceName(tenant.id), data })
    .expect(200, { received: true });
}

function ack(keyId: string, status: string | number, extra: Record<string, unknown> = {}) {
  return {
    keyId,
    remoteJid: PATIENT_JID,
    fromMe: true,
    participant: null,
    status,
    instanceId: 'instancia',
    ...extra,
  };
}

async function sentMessage(tenantId: string, conversationId: string, externalId: string) {
  return seedMessage({
    tenantId,
    conversationId,
    senderType: 'agent',
    content: 'Seu exame fica pronto amanhã',
    status: 'sent',
    externalMessageId: externalId,
    db,
  });
}

async function statusOf(tenantId: string, id: string): Promise<string | undefined> {
  return (await messages.findById(tenantId, id))?.status;
}

describe('assinatura do webhook', () => {
  it('EVOLUTION_WEBHOOK_EVENTS inclui MESSAGES_UPDATE e PRESENCE_UPDATE (instância antiga recebe no boot, D-223)', () => {
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('MESSAGES_UPDATE');
    expect(EVOLUTION_WEBHOOK_EVENTS).toContain('PRESENCE_UPDATE');
  });
});

describe('messages.update — tiques (D-225)', () => {
  it('sent -> DELIVERY_ACK -> READ, com WS a cada subida e read_at gravado', async () => {
    const { tenant, conversationId } = await lab('lab-tique');
    const message = await sentMessage(tenant.id, conversationId, '3EB0TIQUE');

    await post('lab-tique', tenant, 'messages.update', ack('3EB0TIQUE', 'DELIVERY_ACK'));
    expect(await statusOf(tenant.id, message.id)).toBe('delivered');

    await post('lab-tique', tenant, 'messages.update', ack('3EB0TIQUE', 'READ'));
    const read = await messages.findById(tenant.id, message.id);
    expect(read?.status).toBe('read');
    expect(read?.readAt).not.toBeNull();

    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated').map((e) => e.data)).toEqual([
      { conversationId, messageId: message.id, status: 'delivered' },
      { conversationId, messageId: message.id, status: 'read' },
    ]);
  });

  it('aceita o número do enum: 3 -> delivered, 5 (PLAYED, áudio ouvido) -> read', async () => {
    const { tenant, conversationId } = await lab('lab-numero');
    const message = await sentMessage(tenant.id, conversationId, '3EB0NUM');

    await post('lab-numero', tenant, 'messages.update', ack('3EB0NUM', 3));
    expect(await statusOf(tenant.id, message.id)).toBe('delivered');
    await post('lab-numero', tenant, 'messages.update', ack('3EB0NUM', 5));
    expect(await statusOf(tenant.id, message.id)).toBe('read');
  });

  it('ack fora de ordem não rebaixa: READ e depois DELIVERY_ACK fica read, um WS só', async () => {
    const { tenant, conversationId } = await lab('lab-ordem');
    const message = await sentMessage(tenant.id, conversationId, '3EB0ORDEM');

    await post('lab-ordem', tenant, 'messages.update', ack('3EB0ORDEM', 'READ'));
    await post('lab-ordem', tenant, 'messages.update', ack('3EB0ORDEM', 'DELIVERY_ACK'));
    await post('lab-ordem', tenant, 'messages.update', ack('3EB0ORDEM', 'SERVER_ACK'));

    expect(await statusOf(tenant.id, message.id)).toBe('read');
    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated')).toHaveLength(1);
  });

  it('paciente sem confirmação de leitura: sem READ, fica em delivered (✓✓ cinza)', async () => {
    const { tenant, conversationId } = await lab('lab-sem-leitura');
    const message = await sentMessage(tenant.id, conversationId, '3EB0SEMLER');

    await post('lab-sem-leitura', tenant, 'messages.update', ack('3EB0SEMLER', 'SERVER_ACK'));
    await post('lab-sem-leitura', tenant, 'messages.update', ack('3EB0SEMLER', 'DELIVERY_ACK'));
    expect(await statusOf(tenant.id, message.id)).toBe('delivered');
  });

  it('ERROR só derruba pending/sent — entregue não "falha" depois', async () => {
    const { tenant, conversationId } = await lab('lab-erro');
    const enviada = await sentMessage(tenant.id, conversationId, '3EB0ERRO1');
    const entregue = await sentMessage(tenant.id, conversationId, '3EB0ERRO2');
    await post('lab-erro', tenant, 'messages.update', ack('3EB0ERRO2', 'DELIVERY_ACK'));

    await post('lab-erro', tenant, 'messages.update', ack('3EB0ERRO1', 'ERROR'));
    await post('lab-erro', tenant, 'messages.update', ack('3EB0ERRO2', 0));

    expect(await statusOf(tenant.id, enviada.id)).toBe('failed');
    expect(await statusOf(tenant.id, entregue.id)).toBe('delivered');
  });

  it('sem efeito: PENDING, fromMe false, status@broadcast, status desconhecido e lote em array', async () => {
    const { tenant, conversationId } = await lab('lab-ignora');
    const message = await sentMessage(tenant.id, conversationId, '3EB0IGN');
    const paciente = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      senderType: 'patient',
      status: 'delivered',
      externalMessageId: '3EB0PAC',
      db,
    });

    await post('lab-ignora', tenant, 'messages.update', ack('3EB0IGN', 'PENDING'));
    await post('lab-ignora', tenant, 'messages.update', ack('3EB0IGN', 'QUALQUER'));
    await post('lab-ignora', tenant, 'messages.update', ack('3EB0IGN', 'READ', { remoteJid: 'status@broadcast' }));
    await post('lab-ignora', tenant, 'messages.update', ack('3EB0PAC', 'READ', { fromMe: false }));
    expect(await statusOf(tenant.id, message.id)).toBe('sent');
    expect(await statusOf(tenant.id, paciente.id)).toBe('delivered');

    // O gateway também pode mandar um lote.
    await post('lab-ignora', tenant, 'messages.update', [ack('3EB0IGN', 'DELIVERY_ACK')]);
    expect(await statusOf(tenant.id, message.id)).toBe('delivered');
  });

  it('isolamento: ack com id externo de outro laboratório não muda nada e não vaza WS', async () => {
    const alfa = await lab('lab-alfa');
    const beta = await lab('lab-beta');
    const doBeta = await sentMessage(beta.tenant.id, beta.conversationId, '3EB0BETA');

    await post('lab-alfa', alfa.tenant, 'messages.update', ack('3EB0BETA', 'READ'));
    // Instância de outro laboratório no envelope: recusado antes de tocar em nada.
    await post('lab-beta', beta.tenant, 'messages.update', ack('3EB0BETA', 'READ'), evolutionInstanceName(alfa.tenant.id));

    expect(await statusOf(beta.tenant.id, doBeta.id)).toBe('sent');
    expect(app.wsHub.eventsFor(alfa.tenant.id, 'message.status_updated')).toHaveLength(0);
    expect(app.wsHub.eventsFor(beta.tenant.id, 'message.status_updated')).toHaveLength(0);
  });
});

describe('MessageRepository.setStatusByExternalId — escada que nunca rebaixa (D-225)', () => {
  it.each([
    ['pending', 'sent', 'sent'],
    ['pending', 'read', 'read'],
    ['sent', 'delivered', 'delivered'],
    ['delivered', 'sent', 'delivered'],
    ['read', 'delivered', 'read'],
    ['read', 'failed', 'read'],
    ['delivered', 'failed', 'delivered'],
    ['sent', 'failed', 'failed'],
    ['pending', 'failed', 'failed'],
    ['failed', 'read', 'failed'],
  ] as const)('%s + %s = %s', async (current, next, expected) => {
    const { tenant, conversationId } = await lab(`lab-${current}-${next}`);
    const seeded = await seedMessage({
      tenantId: tenant.id,
      conversationId,
      senderType: 'agent',
      status: current,
      externalMessageId: `EXT-${current}-${next}`,
      db,
    });
    const changed = await messages.setStatusByExternalId(tenant.id, `EXT-${current}-${next}`, next);
    expect(await statusOf(tenant.id, seeded.id)).toBe(expected);
    expect(changed === null).toBe(expected === current);
  });
});

describe('presence.update — presença do paciente (D-226)', () => {
  function presence(lastKnownPresence: string, extra: Record<string, unknown> = {}, jid = PATIENT_JID) {
    return { id: jid, presences: { [jid]: { lastKnownPresence, ...extra } } };
  }

  async function snapshot(tenantId: string) {
    const result = await db.withoutTenant((tx) =>
      tx.query<{ n: string }>(
        `SELECT (SELECT COUNT(*) FROM messages WHERE tenant_id = $1)
              + (SELECT COUNT(*) FROM conversations WHERE tenant_id = $1)
              + (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = $1) AS n`,
        [tenantId],
      ),
    );
    return String(result.rows[0]?.n);
  }

  it('composing -> typing, paused -> online, recording -> recording; nada gravado', async () => {
    const { tenant, conversationId } = await lab('lab-presenca');
    const before = await snapshot(tenant.id);

    await post('lab-presenca', tenant, 'presence.update', presence('composing'));
    await post('lab-presenca', tenant, 'presence.update', presence('paused'));
    await post('lab-presenca', tenant, 'presence.update', presence('recording'));

    expect(app.wsHub.eventsFor(tenant.id, 'conversation.presence').map((e) => e.data)).toEqual([
      { conversationId, presence: 'typing', lastSeenAt: null },
      { conversationId, presence: 'online', lastSeenAt: null },
      { conversationId, presence: 'recording', lastSeenAt: null },
    ]);
    expect(await snapshot(tenant.id)).toBe(before);
  });

  it('corpo idêntico repetido não é barrado pelo anti-replay (composing de novo)', async () => {
    const { tenant } = await lab('lab-repete');
    await post('lab-repete', tenant, 'presence.update', presence('composing'));
    await post('lab-repete', tenant, 'presence.update', presence('composing'));
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.presence')).toHaveLength(2);
  });

  it('unavailable com lastSeen vira offline + ISO; sem lastSeen (escondido) vira null', async () => {
    const { tenant, conversationId } = await lab('lab-visto');
    await post('lab-visto', tenant, 'presence.update', presence('unavailable', { lastSeen: 1_790_000_000 }));
    await post('lab-visto', tenant, 'presence.update', presence('unavailable'));

    expect(app.wsHub.eventsFor(tenant.id, 'conversation.presence').map((e) => e.data)).toEqual([
      { conversationId, presence: 'offline', lastSeenAt: new Date(1_790_000_000_000).toISOString() },
      { conversationId, presence: 'offline', lastSeenAt: null },
    ]);
  });

  it('sem efeito: número sem conversa (não cria), @lid, grupo e presença desconhecida', async () => {
    const { tenant } = await lab('lab-sem');
    const before = await snapshot(tenant.id);

    await post('lab-sem', tenant, 'presence.update', presence('composing', {}, '5511900000000@s.whatsapp.net'));
    await post('lab-sem', tenant, 'presence.update', presence('composing', {}, '128999376343081@lid'));
    await post('lab-sem', tenant, 'presence.update', presence('composing', {}, '12036302@g.us'));
    await post('lab-sem', tenant, 'presence.update', presence('dancing'));

    expect(app.wsHub.eventsFor(tenant.id, 'conversation.presence')).toHaveLength(0);
    expect(await snapshot(tenant.id)).toBe(before);
  });

  it('isolamento: só a room do laboratório dono recebe; instância trocada é recusada', async () => {
    const alfa = await lab('lab-alfa-p');
    const beta = await lab('lab-beta-p');

    await post('lab-alfa-p', alfa.tenant, 'presence.update', presence('composing'));
    await post('lab-beta-p', beta.tenant, 'presence.update', presence('composing'), evolutionInstanceName(alfa.tenant.id));

    expect(app.wsHub.eventsFor(alfa.tenant.id, 'conversation.presence').map((e) => e.data)).toEqual([
      { conversationId: alfa.conversationId, presence: 'typing', lastSeenAt: null },
    ]);
    expect(app.wsHub.eventsFor(beta.tenant.id, 'conversation.presence')).toHaveLength(0);
  });
});
