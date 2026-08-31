/**
 * `POST /webhooks/evolution/:tenant` (+ `/status`) — gateway Evolution API
 * self-hosted (Onda 7, Bloco B). Autentica por `EVOLUTION_WEBHOOK_TOKEN`
 * (header `apikey`, tempo constante), nao por HMAC — o gateway manda a chave
 * configurada, nao assina o corpo.
 *
 * O teste que mais importa (mesma logica do webhook da Meta, D-SECURITY
 * "Webhooks"): token invalido/ausente NUNCA toca o banco, e a resposta e
 * IDENTICA ao caminho feliz — nao vira oraculo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import type { DbClient } from '../../src/db/types.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { countConversations, countMessages } from '../conversations/helpers.js';
import { createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const TOKEN = 'segredo-do-gateway-evolution-teste';
const WEBHOOK = '/api/v1/webhooks/evolution';

/** Resolver simples: slug -> tenantId, canal sempre ligado (D-074). */
function evolutionCredentialsResolver(slugToId: Map<string, string>): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: '',
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'qr',
  });
  return {
    forTenant: async (tenantId) => build(tenantId),
    byWebhookIdentity: async (identity) => {
      const tenantId = slugToId.get(identity);
      return tenantId ? build(tenantId) : null;
    },
  };
}

function messagesUpsertPayload(options: {
  phone: string;
  text: string;
  name?: string;
  externalId?: string;
}): Record<string, unknown> {
  return {
    event: 'MESSAGES_UPSERT',
    data: {
      key: { remoteJid: `${options.phone}@s.whatsapp.net`, id: options.externalId ?? 'EVO-1' },
      message: { conversation: options.text },
      pushName: options.name ?? 'Maria',
    },
  };
}

function connectionUpdatePayload(state: 'open' | 'close' | 'connecting', owner?: string) {
  return {
    event: 'CONNECTION_UPDATE',
    data: { state, ...(owner ? { owner: `${owner}@s.whatsapp.net` } : {}) },
  };
}

let db: DbClient;
let app: TestApp;
const slugToId = new Map<string, string>();

async function buildApp(): Promise<TestApp> {
  const whatsapp = new WhatsAppService({
    credentials: evolutionCredentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
  slugToId.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  app = await buildApp();
});

describe('POST /webhooks/evolution/:tenant — MESSAGES_UPSERT', () => {
  it('token valido cria a conversa e grava a mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-evo' });
    slugToId.set('lab-evo', tenant.id);

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo`)
      .set('apikey', TOKEN)
      .send(messagesUpsertPayload({ phone: '5548999998888', text: 'Ola', name: 'Maria' }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ patient_name: string; unread_count: number }>(
        'SELECT patient_name, unread_count FROM conversations WHERE tenant_id = $1',
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.patient_name).toBe('Maria');
    expect(row.rows[0]?.unread_count).toBe(1);
  });

  it('reentrega do mesmo externalId nao duplica mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-dedupe' });
    slugToId.set('lab-evo-dedupe', tenant.id);
    const payload = messagesUpsertPayload({
      phone: '5548999998888',
      text: 'Ola',
      externalId: 'EVO-UNICO',
    });

    for (let i = 0; i < 3; i += 1) {
      await app.agent.post(`${WEBHOOK}/lab-evo-dedupe`).set('apikey', TOKEN).send(payload).expect(200);
    }

    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('token invalido/ausente nao toca no banco — mesma resposta do caminho feliz', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-sem-token' });
    slugToId.set('lab-evo-sem-token', tenant.id);
    const payload = messagesUpsertPayload({ phone: '5548999998888', text: 'invasao' });

    const errado = await app.agent
      .post(`${WEBHOOK}/lab-evo-sem-token`)
      .set('apikey', 'token-errado')
      .send(payload);
    expect(errado.status).toBe(200);
    expect(errado.body).toEqual({ received: true });

    const semHeader = await app.agent.post(`${WEBHOOK}/lab-evo-sem-token`).send(payload);
    expect(semHeader.status).toBe(200);
    expect(semHeader.body).toEqual({ received: true });

    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('tenant desconhecido e ignorado, com a mesma resposta', async () => {
    const payload = messagesUpsertPayload({ phone: '5548999998888', text: 'oi' });
    const response = await app.agent
      .post(`${WEBHOOK}/lab-que-nao-existe`)
      .set('apikey', TOKEN)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it('payload malformado nao derruba o servidor', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-lixo' });
    slugToId.set('lab-evo-lixo', tenant.id);

    const lixos: unknown[] = [
      {},
      { event: 'MESSAGES_UPSERT' },
      { event: 'MESSAGES_UPSERT', data: { key: {} } },
      { event: 'MESSAGES_UPSERT', data: null },
      [1, 2, 3],
    ];
    for (const lixo of lixos) {
      const response = await app.agent
        .post(`${WEBHOOK}/lab-evo-lixo`)
        .set('apikey', TOKEN)
        .send(lixo as object);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true });
    }
    expect(await countMessages(tenant.id)).toBe(0);
    await app.agent.get('/health').expect(200);
  });

  it('o webhook de um tenant nunca escreve no outro', async () => {
    const alfa = await createTenant({ slug: 'lab-evo-alfa' });
    const beta = await createTenant({ slug: 'lab-evo-beta' });
    slugToId.set('lab-evo-alfa', alfa.id);
    slugToId.set('lab-evo-beta', beta.id);

    await app.agent
      .post(`${WEBHOOK}/lab-evo-alfa`)
      .set('apikey', TOKEN)
      .send(messagesUpsertPayload({ phone: '5548999998888', text: 'oi alfa' }))
      .expect(200);

    expect(await countMessages(alfa.id)).toBe(1);
    expect(await countMessages(beta.id)).toBe(0);
    expect(await countConversations(beta.id)).toBe(0);
  });
});

describe('POST /webhooks/evolution/:tenant — CONNECTION_UPDATE', () => {
  it('state open marca o canal conectado e grava o telefone, SEM criar mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-connect' });
    slugToId.set('lab-evo-connect', tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode) VALUES ($1, 'whatsapp', 'qr')`,
        [tenant.id],
      ),
    );

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-connect`)
      .set('apikey', TOKEN)
      .send(connectionUpdatePayload('open', '5511987654321'));

    expect(response.status).toBe(200);
    expect(await countMessages(tenant.id)).toBe(0);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean; connected_at: Date | null; phone_number: string | null }>(
        `SELECT is_active, connected_at, phone_number FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.is_active).toBe(true);
    expect(row.rows[0]?.connected_at).not.toBeNull();
    expect(row.rows[0]?.phone_number).toBe('5511987654321');
  });

  it('state close marca o canal desconectado (loggedOut/banimento)', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-close' });
    slugToId.set('lab-evo-close', tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active, connected_at)
         VALUES ($1, 'whatsapp', 'qr', TRUE, NOW())`,
        [tenant.id],
      ),
    );

    await app.agent
      .post(`${WEBHOOK}/lab-evo-close`)
      .set('apikey', TOKEN)
      .send(connectionUpdatePayload('close'))
      .expect(200);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean; connected_at: Date | null }>(
        `SELECT is_active, connected_at FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.is_active).toBe(false);
    expect(row.rows[0]?.connected_at).toBeNull();
  });
});

describe('POST /webhooks/evolution/:tenant/status', () => {
  it('aceita o payload achatado (sem envelope de evento) e atualiza o estado', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-status' });
    slugToId.set('lab-evo-status', tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode) VALUES ($1, 'whatsapp', 'qr')`,
        [tenant.id],
      ),
    );

    await app.agent
      .post(`${WEBHOOK}/lab-evo-status/status`)
      .set('apikey', TOKEN)
      .send({ state: 'open', owner: '5511987654321@s.whatsapp.net' })
      .expect(200);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean }>(
        `SELECT is_active FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.is_active).toBe(true);
  });
});
