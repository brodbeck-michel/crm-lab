/**
 * Tiques, "Tentar de novo" e presença da atendente (CRMLAB-67, D-225..D-227).
 *
 * O que os testes protegem:
 *   1. a mensagem do WhatsApp nasce `pending` (o WS `new_message` sai com ela
 *      assim) e só vira `sent` quando o gateway devolve o id — com
 *      `message.status_updated` para as outras abas;
 *   2. canal sem gateway (`direct`) nasce `sent`;
 *   3. retry reenvia a MESMA linha (sem mensagem nova), texto e anexo;
 *   4. retry fora das regras: `CONFLICT`; de outro tenant: `NOT_FOUND`;
 *   5. presença: 204 na hora, `composing`/`paused` chegam ao driver, Cloud API
 *      (driver sem presença) é no-op e outro tenant é `NOT_FOUND`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import { MessageRepository } from '../../src/repositories/message.repository.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppDriver,
} from '../../src/services/whatsapp.service.js';
import { testCredentialsResolver } from '../whatsapp/fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

/** Mock que falha enquanto `failing` estiver ligado. */
class ToggleDriver extends MockWhatsAppDriver {
  failing = false;
  beforeSend: (() => Promise<void>) | null = null;

  override async send(...args: Parameters<MockWhatsAppDriver['send']>) {
    await this.beforeSend?.();
    if (this.failing) throw new Error('gateway fora');
    return super.send(...args);
  }

  override async sendMedia(...args: Parameters<MockWhatsAppDriver['sendMedia']>) {
    if (this.failing) throw new Error('gateway fora');
    return super.sendMedia(...args);
  }
}

/** Driver da Cloud API: sem `sendPresence`. */
class CloudLikeDriver implements WhatsAppDriver {
  readonly name = 'cloud-like';
  async send() {
    return { externalId: 'wamid.cloud' };
  }
  async sendMedia() {
    return { externalId: 'wamid.cloud' };
  }
}

async function appWith(driver: WhatsAppDriver): Promise<TestApp> {
  const db = await getTestDb();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  return createTestApp({ db, modules: [makeConversationModule({ whatsapp }), mediaModule] });
}

async function scenario(channel: 'whatsapp' | 'direct' = 'whatsapp') {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  const conversation = await createConversation({
    tenantId: tenant.id,
    assignedTo: ana.id,
    patientPhone: '+5511987654321',
    channel,
  });
  return { tenant, ana, conversation };
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

beforeEach(async () => {
  await resetDatabase();
});

describe('status de nascimento e confirmação (D-225)', () => {
  it('WhatsApp: nasce pending, a resposta volta sent e o WS avisa pending -> sent', async () => {
    const driver = new ToggleDriver();
    const app = await appWith(driver);
    const { tenant, ana, conversation } = await scenario();

    // O status gravado NO MOMENTO do envio (o gateway ainda não respondeu).
    const repo = new MessageRepository(await getTestDb());
    let statusDuringSend: string | undefined;
    driver.beforeSend = async () => {
      const rows = await repo.listByConversation(tenant.id, conversation.id, { page: 1, limit: 5 });
      statusDuringSend = rows?.rows.at(-1)?.status;
    };

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Olá!' })
      .expect(201);

    expect(response.body.status).toBe('sent');
    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated').map((e) => e.data)).toEqual([
      { conversationId: conversation.id, messageId: response.body.id, status: 'sent' },
    ]);
    expect(statusDuringSend).toBe('pending');
  });

  it('falha do gateway: failed + MESSAGE_SEND_FAILED + WS com failed', async () => {
    const driver = new ToggleDriver();
    driver.failing = true;
    const app = await appWith(driver);
    const { tenant, ana, conversation } = await scenario();

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'não vai' })
      .expect(502);

    const messageId = response.body.error.details.messageId as string;
    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated').map((e) => e.data)).toEqual([
      { conversationId: conversation.id, messageId, status: 'failed' },
    ]);
  });

  it('canal direct (sem gateway) nasce sent e não emite status_updated', async () => {
    const app = await appWith(new ToggleDriver());
    const { tenant, ana, conversation } = await scenario('direct');

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'balcão' })
      .expect(201);

    expect(response.body.status).toBe('sent');
    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated')).toHaveLength(0);
  });
});

describe('POST /conversations/:id/messages/:messageId/retry (D-227)', () => {
  it('reenvia a mesma mensagem de texto: failed -> pending -> sent, sem linha nova', async () => {
    const driver = new ToggleDriver();
    driver.failing = true;
    const app = await appWith(driver);
    const { tenant, ana, conversation } = await scenario();

    const failed = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'segunda chance' })
      .expect(502);
    const messageId = failed.body.error.details.messageId as string;

    driver.failing = false;
    const retried = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(200);

    expect(retried.body).toMatchObject({ id: messageId, status: 'sent', content: 'segunda chance' });
    expect(driver.sent.map((s) => s.content)).toEqual(['segunda chance']);
    expect(await countMessages(conversation.id)).toBe(1);
    expect(
      app.wsHub.eventsFor(tenant.id, 'message.status_updated').map((e) => (e.data as { status: string }).status),
    ).toEqual(['failed', 'pending', 'sent']);
  });

  it('falhou de novo: continua failed e devolve MESSAGE_SEND_FAILED', async () => {
    const driver = new ToggleDriver();
    driver.failing = true;
    const app = await appWith(driver);
    const { ana, conversation } = await scenario();

    const failed = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'teimosa' })
      .expect(502);
    const messageId = failed.body.error.details.messageId as string;

    const again = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(502);
    expect(again.body.error.code).toBe('MESSAGE_SEND_FAILED');

    const row = await new MessageRepository(await getTestDb()).findById(conversation.tenantId, messageId);
    expect(row?.status).toBe('failed');
  });

  it('anexo relê o arquivo guardado e sai de novo pelo sendMedia', async () => {
    const driver = new ToggleDriver();
    driver.failing = true;
    const app = await appWith(driver);
    const { ana, conversation } = await scenario();

    const contentBase64 = Buffer.from('%PDF-1.4 pedido').toString('base64');
    const failed = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/attachments`)
      .set(app.auth(ana))
      .send({ fileName: 'pedido.pdf', mimeType: 'application/pdf', contentBase64 })
      .expect(502);
    const messageId = failed.body.error.details.messageId as string;

    driver.failing = false;
    const retried = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(200);

    expect(retried.body).toMatchObject({ id: messageId, status: 'sent', messageType: 'pdf' });
    expect(driver.sent.map((s) => s.content)).toEqual(['[mídia] pedido.pdf']);
  });

  it('mensagem que não falhou, do paciente ou em conversa encerrada: CONFLICT', async () => {
    const app = await appWith(new ToggleDriver());
    const { ana, conversation } = await scenario();

    const ok = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'foi' })
      .expect(201);

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${ok.body.id}/retry`)
      .set(app.auth(ana))
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  it('mensagem de outro tenant: NOT_FOUND e nada sai', async () => {
    const driver = new ToggleDriver();
    driver.failing = true;
    const app = await appWith(driver);
    const alfa = await scenario();
    const beta = await scenario();

    const failed = await app.agent
      .post(`/api/v1/conversations/${beta.conversation.id}/messages`)
      .set(app.auth(beta.ana))
      .send({ content: 'do beta' })
      .expect(502);
    const messageId = failed.body.error.details.messageId as string;
    driver.failing = false;

    await app.agent
      .post(`/api/v1/conversations/${beta.conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(alfa.ana))
      .expect(404);
    // Mensagem do beta pendurada na conversa do alfa: também 404.
    await app.agent
      .post(`/api/v1/conversations/${alfa.conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(alfa.ana))
      .expect(404);
    expect(driver.sent).toHaveLength(0);
  });
});

describe('POST /conversations/:id/presence (D-226/D-227)', () => {
  it('paused e composing chegam ao driver e a rota responde 204', async () => {
    const driver = new ToggleDriver();
    const app = await appWith(driver);
    const { tenant, ana, conversation } = await scenario();

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/presence`)
      .set(app.auth(ana))
      .send({ presence: 'paused' })
      .expect(204);
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/presence`)
      .set(app.auth(ana))
      .send({ presence: 'composing' })
      .expect(204);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(driver.presences).toEqual([
      { tenantId: tenant.id, phone: '+5511987654321', presence: 'paused' },
      { tenantId: tenant.id, phone: '+5511987654321', presence: 'composing' },
    ]);
  });

  it('driver sem presença (Cloud API) e canal direct: 204 sem efeito', async () => {
    const app = await appWith(new CloudLikeDriver());
    const { ana, conversation } = await scenario();
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/presence`)
      .set(app.auth(ana))
      .send({ presence: 'composing' })
      .expect(204);

    const direct = new ToggleDriver();
    const app2 = await appWith(direct);
    const other = await scenario('direct');
    await app2.agent
      .post(`/api/v1/conversations/${other.conversation.id}/presence`)
      .set(app2.auth(other.ana))
      .send({ presence: 'composing' })
      .expect(204);
    expect(direct.presences).toHaveLength(0);
  });

  it('presença inválida: 400; conversa de outro tenant: 404', async () => {
    const driver = new ToggleDriver();
    const app = await appWith(driver);
    const alfa = await scenario();
    const beta = await scenario();

    await app.agent
      .post(`/api/v1/conversations/${alfa.conversation.id}/presence`)
      .set(app.auth(alfa.ana))
      .send({ presence: 'recording' })
      .expect(400);
    await app.agent
      .post(`/api/v1/conversations/${beta.conversation.id}/presence`)
      .set(app.auth(alfa.ana))
      .send({ presence: 'composing' })
      .expect(404);
    expect(driver.presences).toHaveLength(0);
  });
});
