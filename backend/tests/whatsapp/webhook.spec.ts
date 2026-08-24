/**
 * POST /webhooks/whatsapp — publico, autenticado por HMAC (SECURITY.md
 * "Webhooks", WORKFLOWS §1).
 *
 * O teste que mais importa: assinatura invalida NAO PODE TOCAR NO BANCO.
 * Nenhuma conversa criada, nenhuma mensagem gravada, nenhum evento de WS.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  createEnvCredentialsResolver,
  safeEquals,
  signWebhookBody,
  verifyWebhookSignature,
} from '../../src/services/whatsapp.service.js';
import { countConversations, countMessages } from '../conversations/helpers.js';
import { createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET, testCredentialsResolver } from './fixtures.js';

const SECRET = TEST_WEBHOOK_SECRET;
const WEBHOOK = '/api/v1/webhooks/whatsapp';

/** Payload no formato da Meta (entry -> changes -> value -> messages). */
function metaPayload(options: {
  phone: string;
  text: string;
  name?: string;
  externalId?: string;
}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'numero-do-lab' },
              contacts: [{ wa_id: options.phone, profile: { name: options.name ?? 'Joao' } }],
              messages: [
                {
                  id: options.externalId ?? 'wamid.ABC123',
                  from: options.phone,
                  timestamp: '1724425200',
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(externalId: string, status: string): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [{ id: externalId, status, recipient_id: '5511987654321' }],
            },
          },
        ],
      },
    ],
  };
}

async function buildApp(slugToId: Map<string, string>): Promise<TestApp> {
  const db = await getTestDb();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
}

describe('assinatura HMAC', () => {
  it('compara em tempo constante e recusa tamanho diferente', () => {
    const body = JSON.stringify({ a: 1 });
    const assinatura = signWebhookBody(body, SECRET);

    expect(verifyWebhookSignature(body, assinatura, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, assinatura, 'outro-segredo')).toBe(false);
    expect(verifyWebhookSignature(`${body} `, assinatura, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=curta', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    // Sem segredo configurado nada e autentico.
    expect(verifyWebhookSignature(body, assinatura, '')).toBe(false);

    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('POST /webhooks/whatsapp — entrada de mensagem', () => {
  let app: TestApp;
  const slugToId = new Map<string, string>();

  beforeEach(async () => {
    await resetDatabase();
    slugToId.clear();
    app = await buildApp(slugToId);
    app.wsHub.clear();
  });

  it('assinatura valida cria a conversa, grava a mensagem e emite o WS', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const payload = metaPayload({
      phone: '5511987654321',
      text: 'Ola, quanto custa um hemograma?',
      name: 'Joao Santos',
    });
    const body = JSON.stringify(payload);

    const response = await app.agent
      .post(`${WEBHOOK}/lab-vida`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    expect(response.body).toEqual({ received: true });

    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);

    const eventos = app.wsHub.eventsFor(tenant.id, 'conversation.new_message');
    expect(eventos).toHaveLength(1);

    // A conversa nasce na fila livre, com o contador de nao lidas em 1.
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ assigned_to: string | null; unread_count: number; patient_name: string }>(
        'SELECT assigned_to, unread_count, patient_name FROM conversations WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.assigned_to).toBeNull();
    expect(row.rows[0]?.unread_count).toBe(1);
    expect(row.rows[0]?.patient_name).toBe('Joao Santos');
  });

  it('ASSINATURA INVALIDA nao toca no banco', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const body = JSON.stringify(metaPayload({ phone: '5511987654321', text: 'invasao' }));

    const response = await app.agent
      .post(`${WEBHOOK}/lab-vida`)
      .set('x-hub-signature-256', signWebhookBody(body, 'segredo-errado'))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    // Resposta identica a do caminho feliz: nao e oraculo.
    expect(response.body).toEqual({ received: true });
    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
    expect(app.wsHub.emitted).toHaveLength(0);
  });

  it('sem cabecalho de assinatura nao toca no banco', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    await app.agent
      .post(`${WEBHOOK}/lab-vida`)
      .send(metaPayload({ phone: '5511987654321', text: 'oi' }))
      .expect(200);

    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('tenant desconhecido e ignorado, com a mesma resposta', async () => {
    const body = JSON.stringify(metaPayload({ phone: '5511987654321', text: 'oi' }));
    const response = await app.agent
      .post(`${WEBHOOK}/lab-que-nao-existe`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    expect(response.body).toEqual({ received: true });
  });

  it('payload malformado nao derruba o servidor', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const lixos: unknown[] = [
      {},
      { entry: 'nao e array' },
      { entry: [{ changes: [{ value: { messages: [{ semFrom: true }] } }] }] },
      { entry: [null] },
      [1, 2, 3],
      { entry: [{ changes: [{ value: { messages: 'texto' } }] }] },
    ];

    for (const lixo of lixos) {
      const body = JSON.stringify(lixo);
      const response = await app.agent
        .post(`${WEBHOOK}/lab-vida`)
        .set('x-hub-signature-256', signWebhookBody(body, SECRET))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
      expect(response.body).toEqual({ received: true });
    }

    expect(await countMessages(tenant.id)).toBe(0);
    // E o servidor continua atendendo depois de todo esse lixo.
    await app.agent.get('/health').expect(200);
  });

  it('reentrega do mesmo externalId nao duplica mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const body = JSON.stringify(
      metaPayload({ phone: '5511987654321', text: 'Ola', externalId: 'wamid.UNICO' }),
    );
    const signature = signWebhookBody(body, SECRET);

    for (let i = 0; i < 3; i += 1) {
      await app.agent
        .post(`${WEBHOOK}/lab-vida`)
        .set('x-hub-signature-256', signature)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    }

    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);
    expect(app.wsHub.eventsFor(tenant.id, 'conversation.new_message')).toHaveLength(1);
  });

  it('mensagens do mesmo telefone reusam a conversa; telefones diferentes criam duas', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const enviar = async (phone: string, text: string, externalId: string): Promise<void> => {
      const body = JSON.stringify(metaPayload({ phone, text, externalId }));
      await app.agent
        .post(`${WEBHOOK}/lab-vida`)
        .set('x-hub-signature-256', signWebhookBody(body, SECRET))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    };

    await enviar('5511987654321', 'primeira', 'wamid.1');
    await enviar('5511987654321', 'segunda', 'wamid.2');
    await enviar('5548999111222', 'de outro paciente', 'wamid.3');

    expect(await countConversations(tenant.id)).toBe(2);
    expect(await countMessages(tenant.id)).toBe(3);
  });

  it('o webhook de um tenant nunca escreve no outro', async () => {
    const alfa = await createTenant({ slug: 'lab-alfa' });
    const beta = await createTenant({ slug: 'lab-beta' });
    slugToId.set('lab-alfa', alfa.id);
    slugToId.set('lab-beta', beta.id);

    const body = JSON.stringify(metaPayload({ phone: '5511987654321', text: 'oi alfa' }));
    await app.agent
      .post(`${WEBHOOK}/lab-alfa`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    expect(await countMessages(alfa.id)).toBe(1);
    expect(await countMessages(beta.id)).toBe(0);
    expect(await countConversations(beta.id)).toBe(0);
    expect(app.wsHub.eventsFor(beta.id)).toHaveLength(0);
  });
});

describe('POST /webhooks/whatsapp/:tenant/status — callback de status', () => {
  let app: TestApp;
  const slugToId = new Map<string, string>();

  beforeEach(async () => {
    await resetDatabase();
    slugToId.clear();
    app = await buildApp(slugToId);
  });

  it('atualiza o status da mensagem pelo id externo', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const inbound = JSON.stringify(
      metaPayload({ phone: '5511987654321', text: 'Ola', externalId: 'wamid.STATUS' }),
    );
    await app.agent
      .post(`${WEBHOOK}/lab-vida`)
      .set('x-hub-signature-256', signWebhookBody(inbound, SECRET))
      .set('Content-Type', 'application/json')
      .send(inbound)
      .expect(200);

    const body = JSON.stringify(statusPayload('wamid.STATUS', 'read'));
    await app.agent
      .post(`${WEBHOOK}/lab-vida/status`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string; read_at: Date | null }>(
        'SELECT status, read_at FROM messages WHERE external_message_id = $1',
        ['wamid.STATUS'],
      ),
    );
    expect(row.rows[0]?.status).toBe('read');
    expect(row.rows[0]?.read_at).not.toBeNull();
  });

  it('status com assinatura invalida nao muda nada', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const inbound = JSON.stringify(
      metaPayload({ phone: '5511987654321', text: 'Ola', externalId: 'wamid.INTOCADO' }),
    );
    await app.agent
      .post(`${WEBHOOK}/lab-vida`)
      .set('x-hub-signature-256', signWebhookBody(inbound, SECRET))
      .set('Content-Type', 'application/json')
      .send(inbound)
      .expect(200);

    const body = JSON.stringify(statusPayload('wamid.INTOCADO', 'failed'));
    await app.agent
      .post(`${WEBHOOK}/lab-vida/status`)
      .set('x-hub-signature-256', 'sha256=00')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string }>(
        'SELECT status FROM messages WHERE external_message_id = $1',
        ['wamid.INTOCADO'],
      ),
    );
    expect(row.rows[0]?.status).toBe('delivered');
  });
});

describe('resolver default de credenciais', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('acha o tenant pelo slug e ignora tenant inativo/inexistente', async () => {
    const db = await getTestDb();
    const ativo = await createTenant({ slug: 'lab-ativo' });
    await createTenant({ slug: 'lab-inativo', isActive: false });
    const resolver = createEnvCredentialsResolver(db);

    const encontrado = await resolver.byWebhookIdentity('lab-ativo');
    expect(encontrado?.tenantId).toBe(ativo.id);
    // Pelo uuid tambem funciona.
    expect((await resolver.byWebhookIdentity(ativo.id))?.tenantId).toBe(ativo.id);

    expect(await resolver.byWebhookIdentity('lab-inativo')).toBeNull();
    expect(await resolver.byWebhookIdentity('nao-existe')).toBeNull();
    expect(await resolver.byWebhookIdentity('')).toBeNull();
  });
});
