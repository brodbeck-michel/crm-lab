/**
 * CRMLAB-137 — janela de 24 h da Cloud API (D-310).
 *
 * `cloud_api`: texto livre e anexo só se o PACIENTE escreveu nas últimas 24 h;
 * fora disso 409 `WHATSAPP_WINDOW_CLOSED` ANTES de gravar. Modo `qr` não muda.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { ConversationRepository } from '../../src/repositories/conversation.repository.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import { MessageService } from '../../src/services/message.service.js';
import { createWhatsAppWindowGuard } from '../../src/services/whatsapp-window.service.js';
import { MockWhatsAppDriver, WhatsAppService } from '../../src/services/whatsapp.service.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { FakeWsHub } from '../helpers/fake-ws.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let driver: MockWhatsAppDriver;
let whatsapp: WhatsAppService;
let app: TestApp;

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function channel(tenantId: string, mode: 'qr' | 'cloud_api'): Promise<void> {
  await exec(
    `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode)
     VALUES ($1, 'whatsapp', TRUE, $2)
     ON CONFLICT (tenant_id, channel) DO UPDATE SET connection_mode = $2`,
    [tenantId, mode],
  );
}

async function say(
  tenantId: string,
  conversationId: string,
  senderType: 'agent' | 'patient',
  hoursAgo: number,
  status = 'sent',
): Promise<void> {
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, message_type,
                           status, created_at)
     VALUES ($1, $2, $3, $4, 'oi', 'text', $5, NOW() - ($6 || ' minutes')::interval)`,
    [randomUUID(), tenantId, conversationId, senderType, status, String(Math.round(hoursAgo * 60))],
  );
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

async function lab(mode: 'qr' | 'cloud_api') {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  await channel(tenant.id, mode);
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  return { tenant, ana, conversation };
}

function send(conversationId: string, user: { id: string }) {
  return app.agent
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(app.auth(user as Parameters<TestApp['auth']>[0]))
    .send({ content: 'Olá, segue o orçamento', messageType: 'text' });
}

function attach(conversationId: string, user: { id: string }) {
  return app.agent
    .post(`/api/v1/conversations/${conversationId}/attachments`)
    .set(app.auth(user as Parameters<TestApp['auth']>[0]))
    .send({
      fileName: 'preparo.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 preparo').toString('base64'),
    });
}

beforeEach(async () => {
  await resetDatabase();
  const db = await getTestDb();
  driver = new MockWhatsAppDriver();
  whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  app = await createTestApp({ db, modules: [makeConversationModule({ whatsapp })] });
});

describe('cloud_api: texto livre (D-310)', () => {
  it('paciente escreveu há 1 h: envia', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 1);

    await send(conversation.id, ana).expect(201);
    expect(driver.sent).toHaveLength(1);
  });

  it('paciente escreveu há 25 h: 409, nada gravado nem enviado', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 25);
    const before = await countMessages(conversation.id);

    const response = await send(conversation.id, ana).expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    const details = response.body.error.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['conversationId', 'lastPatientMessageAt', 'windowClosedAt']);
    expect(details.conversationId).toBe(conversation.id);
    // Fechou 24 h depois da fala do paciente (há 25 h): ~1 h atrás.
    const closedAt = Date.parse(details.windowClosedAt as string);
    expect(Date.now() - closedAt).toBeGreaterThan(55 * 60_000);
    expect(Date.now() - closedAt).toBeLessThan(65 * 60_000);
    expect(await countMessages(conversation.id)).toBe(before);
    expect(driver.sent).toHaveLength(0);
  });

  it('mensagem do paciente apagada não conta para a janela', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 30);
    await say(tenant.id, conversation.id, 'patient', 1);
    await exec(
      `UPDATE messages SET deleted_at = NOW(), deleted_by = 'patient'
        WHERE conversation_id = $1 AND created_at > NOW() - interval '2 hours'`,
      [conversation.id],
    );

    const response = await send(conversation.id, ana).expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
  });

  it('encerrada com a janela fechada: 409 e a conversa NÃO reabre nem muda de dona', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    const bia = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bia' });
    await channel(tenant.id, 'cloud_api');
    const encerrada = await createConversation({
      tenantId: tenant.id,
      assignedTo: bia.id,
      status: 'closed',
    });
    await say(tenant.id, encerrada.id, 'patient', 30);

    await send(encerrada.id, ana).expect(409);
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string; assigned_to: string | null }>(
        'SELECT status, assigned_to FROM conversations WHERE id = $1',
        [encerrada.id],
      ),
    );
    expect(row.rows[0]).toEqual({ status: 'closed', assigned_to: bia.id });
  });

  it('a fala da atendente não abre a janela: só a do paciente conta', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 30);
    await say(tenant.id, conversation.id, 'agent', 1);

    const response = await send(conversation.id, ana).expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
  });

  it('paciente nunca escreveu: fora da janela', async () => {
    const { ana, conversation } = await lab('cloud_api');

    const response = await send(conversation.id, ana).expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(response.body.error.details.lastPatientMessageAt).toBeNull();
    expect(driver.sent).toHaveLength(0);
  });

  it('mensagem de outro laboratório com o MESMO conversation_id não abre a janela (tenant_id)', async () => {
    const { ana, conversation } = await lab('cloud_api');
    const other = await lab('cloud_api');
    // Linha forjada: outro tenant, mas apontando para a conversa deste. So o
    // filtro por tenant_id (e o RLS) impede que ela conte.
    await say(other.tenant.id, conversation.id, 'patient', 1);

    await send(conversation.id, ana).expect(409);
  });

  it('fila livre: conversa sem dona NÃO é assumida no 409', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    await channel(tenant.id, 'cloud_api');
    const livre = await createConversation({ tenantId: tenant.id, assignedTo: null });
    await say(tenant.id, livre.id, 'patient', 30);

    await send(livre.id, ana).expect(409);
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ assigned_to: string | null }>('SELECT assigned_to FROM conversations WHERE id = $1', [
        livre.id,
      ]),
    );
    expect(row.rows[0]?.assigned_to).toBeNull();
  });

  it('conversa direct num laboratório cloud_api não tem janela: grava sem ir ao WhatsApp', async () => {
    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
    await channel(tenant.id, 'cloud_api');
    const direta = await createConversation({ tenantId: tenant.id, assignedTo: ana.id, channel: 'direct' });

    await send(direta.id, ana).expect(201);
    expect(driver.sent).toHaveLength(0);
  });

  it('credencial e janela falhando juntas: sai CHANNEL_CLOUD_API_NOT_CONFIGURED (ordem do contrato)', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 30);
    const base = testCredentialsResolver(new Map());
    const semCredencial = await createTestApp({
      db: await getTestDb(),
      modules: [
        makeConversationModule({
          whatsapp: new WhatsAppService({
            credentials: {
              forTenant: async (tenantId) => ({
                ...(await base.forTenant(tenantId)),
                apiUrl: 'https://graph.test',
                wabaId: '',
                apiToken: '',
              }),
              byWebhookIdentity: base.byWebhookIdentity,
            },
            driver,
            queue: createInMemoryQueue({ sleep: async () => undefined }),
            attempts: 1,
          }),
        }),
      ],
    });

    const response = await semCredencial.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(semCredencial.auth(ana))
      .send({ content: 'oi' })
      .expect(409);
    expect(response.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
  });
});

describe('cloud_api: anexo, áudio e reenvio (D-310)', () => {
  it('anexo dentro da janela sai; fora, 409 sem gravar', async () => {
    const open = await lab('cloud_api');
    await say(open.tenant.id, open.conversation.id, 'patient', 2);
    await attach(open.conversation.id, open.ana).expect(201);
    expect(driver.sent).toHaveLength(1);

    const closed = await lab('cloud_api');
    await say(closed.tenant.id, closed.conversation.id, 'patient', 26);
    const before = await countMessages(closed.conversation.id);
    const response = await attach(closed.conversation.id, closed.ana).expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(await countMessages(closed.conversation.id)).toBe(before);
    expect(driver.sent).toHaveLength(1);
    // Nada de mídia gravada para o anexo recusado.
    const db = await getTestDb();
    const media = await db.withoutTenant((tx) =>
      tx.query('SELECT 1 FROM message_media WHERE tenant_id = $1', [closed.tenant.id]),
    );
    expect(media.rows).toHaveLength(0);
  });

  it('"tentar de novo" de mensagem falhada também respeita a janela', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 30);
    const failedId = randomUUID();
    await exec(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, sender_id, content,
                             message_type, status)
       VALUES ($1, $2, $3, 'agent', $4, 'oi', 'text', 'failed')`,
      [failedId, tenant.id, conversation.id, ana.id],
    );

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${failedId}/retry`)
      .set(app.auth(ana))
      .expect(409);
    expect(response.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(driver.sent).toHaveLength(0);
    // Continua `failed`: a recusa vem antes de passar a `pending`.
    const db = await getTestDb();
    const status = await db.withoutTenant((tx) =>
      tx.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [failedId]),
    );
    expect(status.rows[0]?.status).toBe('failed');
  });

  it('mensagem automática (mesmo caminho do sistema) não fura a janela', async () => {
    const { tenant, conversation } = await lab('cloud_api');
    const db = await getTestDb();
    const service = new MessageService({
      messages: new MessageRepository(db),
      conversations: new ConversationRepository(db),
      wsHub: new FakeWsHub(),
      whatsapp,
      windowGuard: createWhatsAppWindowGuard({ db }),
    });

    await expect(
      service.createAutomated(tenant.id, conversation.id, 'Sentimos sua falta'),
    ).rejects.toMatchObject({ code: 'WHATSAPP_WINDOW_CLOSED' });
    expect(await countMessages(conversation.id)).toBe(0);
    expect(driver.sent).toHaveLength(0);

    await say(tenant.id, conversation.id, 'patient', 1);
    await service.createAutomated(tenant.id, conversation.id, 'Fora do horário', 'offhours');
    expect(driver.sent).toHaveLength(1);
  });
});

describe('modo qr: nada muda', () => {
  it('texto e anexo saem mesmo com o paciente mudo há 48 h ou nunca tendo escrito', async () => {
    const { tenant, ana, conversation } = await lab('qr');
    await send(conversation.id, ana).expect(201);
    await say(tenant.id, conversation.id, 'patient', 48);
    await send(conversation.id, ana).expect(201);
    await attach(conversation.id, ana).expect(201);
    expect(driver.sent).toHaveLength(3);
  });
});

describe('estado da janela no GET /conversations/:id', () => {
  it('cloud_api aberta: restante calculado no servidor', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    await say(tenant.id, conversation.id, 'patient', 20);

    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    const window = response.body.whatsappWindow;
    expect(window.open).toBe(true);
    expect(window.remainingSeconds).toBeGreaterThan(3.9 * 3600);
    expect(window.remainingSeconds).toBeLessThanOrEqual(4 * 3600);
    expect(window.expiresAt).toMatch(/Z$/);
  });

  it('cloud_api fechada e sem fala do paciente', async () => {
    const { tenant, ana, conversation } = await lab('cloud_api');
    const never = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(never.body.whatsappWindow).toMatchObject({ open: false, remainingSeconds: 0, expiresAt: null });

    await say(tenant.id, conversation.id, 'patient', 30);
    const old = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(old.body.whatsappWindow).toMatchObject({ open: false, remainingSeconds: 0 });
  });

  it('qr: sem restrição (null)', async () => {
    const { ana, conversation } = await lab('qr');
    const response = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(response.body.whatsappWindow).toBeNull();
  });
});
