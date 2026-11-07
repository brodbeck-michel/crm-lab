/**
 * CRMLAB-134 — primeiro contato (D-305) e teto por hora no WhatsApp por QR (D-306).
 *
 * Primeiro contato = mensagem de atendente para conversa sem mensagem do
 * paciente e sem mensagem de atendente que não falhou. Acima do teto da janela
 * móvel de 60 min: 409 `FIRST_CONTACT_LIMIT_REACHED` ANTES de gravar.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MockWhatsAppDriver, WhatsAppService } from '../../src/services/whatsapp.service.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

class ToggleDriver extends MockWhatsAppDriver {
  failing = false;
  override async send(...args: Parameters<MockWhatsAppDriver['send']>) {
    if (this.failing) throw new Error('gateway fora');
    return super.send(...args);
  }
}

let driver: ToggleDriver;
let app: TestApp;

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function qrChannel(tenantId: string, mode: 'qr' | 'cloud_api' = 'qr'): Promise<void> {
  await exec(
    `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode)
     VALUES ($1, 'whatsapp', TRUE, $2)
     ON CONFLICT (tenant_id, channel) DO UPDATE SET connection_mode = $2`,
    [tenantId, mode],
  );
}

async function limit(tenantId: string, rule: { enabled: boolean; perHour: number }): Promise<void> {
  await exec(
    `INSERT INTO funnel_rules (tenant_id, rules) VALUES ($1, $2::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET rules = $2::jsonb`,
    [tenantId, JSON.stringify({ firstContactLimit: rule })],
  );
}

async function message(
  tenantId: string,
  conversationId: string,
  senderType: 'agent' | 'patient' | 'system',
  opts: { status?: string; minutesAgo?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, message_type,
                           status, created_at)
     VALUES ($1, $2, $3, $4, 'oi', 'text', $5, NOW() - ($6 || ' minutes')::interval)`,
    [id, tenantId, conversationId, senderType, opts.status ?? 'sent', String(opts.minutesAgo ?? 0)],
  );
  return id;
}

async function countMessages(conversationId: string): Promise<number> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM messages WHERE conversation_id = $1', [
      conversationId,
    ]),
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function lab(perHour = 2) {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  await qrChannel(tenant.id);
  await limit(tenant.id, { enabled: true, perHour });
  const cold = () => createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  return { tenant, ana, cold };
}

function send(conversationId: string, user: { id: string }, content = 'Olá, segue o orçamento') {
  return app.agent
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(app.auth(user as Parameters<TestApp['auth']>[0]))
    .send({ content, messageType: 'text' });
}

beforeEach(async () => {
  await resetDatabase();
  const db = await getTestDb();
  driver = new ToggleDriver();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  app = await createTestApp({ db, modules: [makeConversationModule({ whatsapp })] });
});

describe('teto de primeiros contatos (D-306)', () => {
  it('passa até o teto; o seguinte é 409 e nada é gravado nem enviado', async () => {
    const { ana, cold } = await lab(2);
    const [a, b, c] = [await cold(), await cold(), await cold()];

    await send(a.id, ana).expect(201);
    await send(b.id, ana).expect(201);
    const sentBefore = driver.sent.length;

    const response = await send(c.id, ana).expect(409);
    expect(response.body.error.code).toBe('FIRST_CONTACT_LIMIT_REACHED');
    expect(response.body.error.details.limit).toBe(2);
    expect(response.body.error.details.retryAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await countMessages(c.id)).toBe(0);
    expect(driver.sent.length).toBe(sentBefore);
  });

  it('retryAt = quando o contato mais antigo da janela sai dela', async () => {
    const { tenant, ana, cold } = await lab(1);
    const old = await cold();
    await message(tenant.id, old.id, 'agent', { minutesAgo: 40 });

    const response = await send((await cold()).id, ana).expect(409);
    const retryAt = new Date(response.body.error.details.retryAt).getTime();
    const expected = Date.now() + 20 * 60_000;
    expect(Math.abs(retryAt - expected)).toBeLessThan(2 * 60_000);
  });

  it('conversa em que o paciente já escreveu não é primeiro contato', async () => {
    const { tenant, ana, cold } = await lab(1);
    await send((await cold()).id, ana).expect(201);
    const warm = await cold();
    await message(tenant.id, warm.id, 'patient', { minutesAgo: 5 });

    await send(warm.id, ana).expect(201);
  });

  it('conversa já contatada (mesmo sem resposta) e segunda mensagem na mesma conversa passam', async () => {
    const { tenant, ana, cold } = await lab(1);
    const yesterday = await cold();
    await message(tenant.id, yesterday.id, 'agent', { minutesAgo: 60 * 24 });
    const now = await cold();

    await send(now.id, ana).expect(201);
    await send(now.id, ana, 'Segunda mensagem').expect(201);
    await send(yesterday.id, ana).expect(201);
  });

  it('o contato de ontem não conta na janela de agora', async () => {
    const { tenant, ana, cold } = await lab(1);
    await message(tenant.id, (await cold()).id, 'agent', { minutesAgo: 61 });
    await send((await cold()).id, ana).expect(201);
  });

  it('mensagem que falhou não conta, e a conversa dela continua sendo primeiro contato', async () => {
    const { tenant, ana, cold } = await lab(1);
    const failedOnly = await cold();
    await message(tenant.id, failedOnly.id, 'agent', { status: 'failed', minutesAgo: 5 });

    await send((await cold()).id, ana).expect(201);
    const response = await send(failedOnly.id, ana).expect(409);
    expect(response.body.error.code).toBe('FIRST_CONTACT_LIMIT_REACHED');
  });

  it('mensagem de sistema não tira a conversa do primeiro contato', async () => {
    const { tenant, ana, cold } = await lab(1);
    await send((await cold()).id, ana).expect(201);
    const withEvent = await cold();
    await message(tenant.id, withEvent.id, 'system');
    await send(withEvent.id, ana).expect(409);
  });

  it('regra desligada, canal pela API oficial ou canal desativado: sem teto', async () => {
    const off = await lab(1);
    await limit(off.tenant.id, { enabled: false, perHour: 1 });
    await send((await off.cold()).id, off.ana).expect(201);
    await send((await off.cold()).id, off.ana).expect(201);

    // Na API oficial o teto não vale; o primeiro contato esbarra antes na janela
    // de 24 h (D-310: paciente nunca escreveu = só template), nunca no teto.
    const cloud = await lab(1);
    await qrChannel(cloud.tenant.id, 'cloud_api');
    for (let i = 0; i < 2; i += 1) {
      const response = await send((await cloud.cold()).id, cloud.ana).expect(409);
      expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    }
  });

  it('laboratório sem regra gravada usa o padrão (ligado, 8 por hora)', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    await qrChannel(tenant.id);
    for (let i = 0; i < 8; i += 1) {
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
      await send(conversation.id, ana).expect(201);
    }
    const ninth = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
    const response = await send(ninth.id, ana).expect(409);
    expect(response.body.error.details.limit).toBe(8);
  });

  it('o teto é por laboratório', async () => {
    const alfa = await lab(1);
    const beta = await lab(1);
    await send((await alfa.cold()).id, alfa.ana).expect(201);
    await send((await beta.cold()).id, beta.ana).expect(201);
  });

  it('"tentar de novo" de primeiro contato acima do teto: 409 e a mensagem continua failed', async () => {
    const { tenant, ana, cold } = await lab(1);
    const target = await cold();
    driver.failing = true;
    const failed = await send(target.id, ana).expect(502);
    const messageId = failed.body.error.details.messageId as string;
    driver.failing = false;
    await send((await cold()).id, ana).expect(201);

    const response = await app.agent
      .post(`/api/v1/conversations/${target.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(409);
    expect(response.body.error.code).toBe('FIRST_CONTACT_LIMIT_REACHED');
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [messageId]),
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(tenant.id).toBeTruthy();
  });

  it('Nova conversa acima do teto: 409 com conversationId e a conversa fica criada, sem mensagem', async () => {
    const { ana, cold } = await lab(1);
    await send((await cold()).id, ana).expect(201);

    const response = await app.agent
      .post('/api/v1/conversations/whatsapp')
      .set(app.auth(ana))
      .send({ phone: '(48) 99888-7766', content: 'Olá! Aqui é do laboratório.' })
      .expect(409);
    expect(response.body.error.code).toBe('FIRST_CONTACT_LIMIT_REACHED');
    const conversationId = response.body.error.details.conversationId as string;
    expect(conversationId).toBeTruthy();
    expect(await countMessages(conversationId)).toBe(0);
  });
});

describe('Conversation.patientHasWritten (D-305)', () => {
  it('false sem mensagem do paciente; true depois que ele escreve (lista e detalhe)', async () => {
    const { tenant, ana, cold } = await lab(8);
    const conversation = await cold();
    await message(tenant.id, conversation.id, 'agent');

    const before = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(before.body.conversation.patientHasWritten).toBe(false);

    await message(tenant.id, conversation.id, 'patient');
    const list = await app.agent.get('/api/v1/conversations').set(app.auth(ana)).expect(200);
    const item = list.body.conversations.find((c: { id: string }) => c.id === conversation.id);
    expect(item.patientHasWritten).toBe(true);
  });
});
