/**
 * Envio pelo canal externo — SERVICES.md §11 + API_ERRORS.md (`MESSAGE_SEND_FAILED`).
 *
 * A falha transitoria tem que sobreviver ao retry; a permanente tem que deixar
 * a mensagem gravada como `failed` e devolver 502 — nunca sumir da tela.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppDriver,
} from '../../src/services/whatsapp.service.js';
import { testCredentialsResolver } from './fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

/** Driver que falha `failures` vezes antes de entregar. */
class FlakyDriver implements WhatsAppDriver {
  readonly name = 'flaky';
  calls = 0;

  constructor(private readonly failures: number) {}

  async send(): Promise<{ externalId: string }> {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error('502 do gateway');
    return { externalId: `wamid.ok.${this.calls}` };
  }

  async sendMedia(): Promise<{ externalId: string }> {
    return this.send();
  }
}

/** Atrasos coletados sem esperar de verdade. */
function fakeQueue(): { queue: ReturnType<typeof createInMemoryQueue>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    queue: createInMemoryQueue({
      sleep: async (ms) => {
        delays.push(ms);
      },
      defaults: { backoffMs: 20 },
    }),
  };
}

async function appWithDriver(driver: WhatsAppDriver): Promise<{
  app: TestApp;
  delays: number[];
}> {
  const db = await getTestDb();
  const { queue, delays } = fakeQueue();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(new Map()),
    driver,
    queue,
    attempts: 3,
  });
  const app = await createTestApp({
    db,
    modules: [makeConversationModule({ whatsapp })],
  });
  return { app, delays };
}

describe('POST /conversations/:id/messages — canal externo', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('driver mock ecoa: a mensagem sai com status sent', async () => {
    const driver = new MockWhatsAppDriver();
    const { app } = await appWithDriver(driver);

    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      patientPhone: '+5511987654321',
    });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Ola!' })
      .expect(201);

    expect(response.body.status).toBe('sent');
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]).toMatchObject({
      tenantId: tenant.id,
      phone: '+5511987654321',
      content: 'Ola!',
    });
  });

  it('falha transitoria: tenta 3 vezes e sucede — a mensagem fica sent', async () => {
    const driver = new FlakyDriver(2);
    const { app, delays } = await appWithDriver(driver);

    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'aguenta ai' })
      .expect(201);

    expect(driver.calls).toBe(3);
    expect(delays).toEqual([20, 40]);
    expect(response.body.status).toBe('sent');
  });

  it('falha permanente: 3 tentativas, status failed e MESSAGE_SEND_FAILED (502)', async () => {
    const driver = new FlakyDriver(Number.POSITIVE_INFINITY);
    const { app } = await appWithDriver(driver);

    const tenant = await createTenant();
    const ana = await createUser({ tenantId: tenant.id, role: 'attendant' });
    const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });

    const response = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'nao vai passar' })
      .expect(502);

    expect(response.body.error.code).toBe('MESSAGE_SEND_FAILED');
    expect(response.body.error.statusCode).toBe(502);
    expect(driver.calls).toBe(3);

    // A mensagem NAO some: fica gravada como falha, para o atendente reenviar.
    const detalhe = await app.agent
      .get(`/api/v1/conversations/${conversation.id}`)
      .set(app.auth(ana))
      .expect(200);
    expect(detalhe.body.messages).toHaveLength(1);
    expect(detalhe.body.messages[0].status).toBe('failed');
    expect(detalhe.body.messages[0].content).toBe('nao vai passar');

    // E o evento de tempo real foi emitido mesmo assim (a bolha existe).
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
  });
});

describe('WhatsAppService.send — credenciais por tenant', () => {
  beforeAll(async () => {
    await getTestDb();
  });

  it('cada envio usa as credenciais do proprio laboratorio', async () => {
    const driver = new MockWhatsAppDriver();
    const service = new WhatsAppService({
      credentials: testCredentialsResolver(new Map()),
      driver,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
    });

    await service.send('tenant-a', '+551199999', 'oi A');
    await service.send('tenant-b', '+551188888', 'oi B');

    expect(driver.sent.map((m) => m.tenantId)).toEqual(['tenant-a', 'tenant-b']);
  });
});
