/**
 * `POST /webhooks/evolution/:tenant` (+ `/status`) — gateway Evolution API
 * self-hosted (Onda 7, Bloco B). Autentica pelo header DOCUMENTADO
 * `x-evolution-webhook-token` (API_CONTRACTS.md:729-735), com `apikey` tolerado
 * como alternativa (ruling do coordenador, Critical 2 da revisao). Tempo
 * constante, nao HMAC — o gateway manda a chave configurada, nao assina o
 * corpo.
 *
 * O teste que mais importa (mesma logica do webhook da Meta, SECURITY.md
 * "Webhooks"): token invalido/ausente NUNCA toca o banco, e a resposta e
 * IDENTICA ao caminho feliz — nao vira oraculo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { evolutionInstanceName } from '../../src/lib/evolution-client.js';
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

/**
 * Resolver simples: slug -> tenantId, canal ligado por default (D-074).
 * `disabled` deixa o teste do kill switch (M9 da revisao da Task 5) forjar
 * `isActive: false` sem precisar de uma escrita real em `tenant_channels`.
 */
function evolutionCredentialsResolver(
  slugToId: Map<string, string>,
  disabled: Set<string> = new Set(),
): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: '',
    isActive: !disabled.has(tenantId),
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
  instance: string;
  phone: string;
  text: string;
  name?: string;
  externalId?: string;
}): Record<string, unknown> {
  return {
    event: 'MESSAGES_UPSERT',
    instance: options.instance,
    data: {
      key: { remoteJid: `${options.phone}@s.whatsapp.net`, id: options.externalId ?? 'EVO-1' },
      message: { conversation: options.text },
      pushName: options.name ?? 'Maria',
    },
  };
}

function connectionUpdatePayload(
  instance: string,
  state: 'open' | 'close' | 'connecting',
  owner?: string,
) {
  return {
    event: 'CONNECTION_UPDATE',
    instance,
    data: { state, ...(owner ? { owner: `${owner}@s.whatsapp.net` } : {}) },
  };
}

let db: DbClient;
let app: TestApp;
const slugToId = new Map<string, string>();
const disabledTenants = new Set<string>();

async function buildApp(): Promise<TestApp> {
  const whatsapp = new WhatsAppService({
    credentials: evolutionCredentialsResolver(slugToId, disabledTenants),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
  slugToId.clear();
  disabledTenants.clear();
  process.env.EVOLUTION_WEBHOOK_TOKEN = TOKEN;
  app = await buildApp();
});

afterEach(() => {
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
});

describe('POST /webhooks/evolution/:tenant — MESSAGES_UPSERT', () => {
  it('header documentado x-evolution-webhook-token cria a conversa e grava a mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-evo' });
    slugToId.set('lab-evo', tenant.id);

    // Critical 2 da revisao: o header DOCUMENTADO (API_CONTRACTS.md:729-735)
    // e o que a infra configura — antes deste fix, so `apikey` funcionava.
    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(tenant.id),
          phone: '5548999998888',
          text: 'Ola',
          name: 'Maria',
        }),
      );

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

  it('header apikey (tolerado) tambem funciona', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-apikey' });
    slugToId.set('lab-evo-apikey', tenant.id);

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-apikey`)
      .set('apikey', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(tenant.id),
          phone: '5548999998888',
          text: 'Ola',
        }),
      );
    expect(response.status).toBe(200);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('reentrega do mesmo externalId nao duplica mensagem', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-dedupe' });
    slugToId.set('lab-evo-dedupe', tenant.id);
    const payload = messagesUpsertPayload({
      instance: evolutionInstanceName(tenant.id),
      phone: '5548999998888',
      text: 'Ola',
      externalId: 'EVO-UNICO',
    });

    for (let i = 0; i < 3; i += 1) {
      await app.agent
        .post(`${WEBHOOK}/lab-evo-dedupe`)
        .set('x-evolution-webhook-token', TOKEN)
        .send(payload)
        .expect(200);
    }

    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('token invalido/ausente nao toca no banco — mesma resposta do caminho feliz', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-sem-token' });
    slugToId.set('lab-evo-sem-token', tenant.id);
    const payload = messagesUpsertPayload({
      instance: evolutionInstanceName(tenant.id),
      phone: '5548999998888',
      text: 'invasao',
    });

    const errado = await app.agent
      .post(`${WEBHOOK}/lab-evo-sem-token`)
      .set('x-evolution-webhook-token', 'token-errado')
      .send(payload);
    expect(errado.status).toBe(200);
    expect(errado.body).toEqual({ received: true });

    const semHeader = await app.agent.post(`${WEBHOOK}/lab-evo-sem-token`).send(payload);
    expect(semHeader.status).toBe(200);
    expect(semHeader.body).toEqual({ received: true });

    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('kill switch (isActive: false) recusa mesmo com token valido — mecanismo do Critical 1', async () => {
    // M9 da revisao: esta era a UNICA branch nao testada no caminho Evolution,
    // e e o exato mecanismo que travava o canal (Critical 1) — um resolver que
    // sempre devolve isActive:true nunca provaria a recusa.
    const tenant = await createTenant({ slug: 'lab-evo-desligado' });
    slugToId.set('lab-evo-desligado', tenant.id);
    disabledTenants.add(tenant.id);

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-desligado`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(tenant.id),
          phone: '5548999998888',
          text: 'canal desligado',
        }),
      );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('instance do payload diferente da resolvida pela URL e recusada (Important 4)', async () => {
    // Quem so tem o token (unico para a instalacao) e um slug PUBLICO nao
    // consegue mais injetar mensagem alheia: precisa tambem acertar
    // `evolutionInstanceName(tenantId)`, que depende do UUID interno.
    const vitima = await createTenant({ slug: 'lab-evo-vitima' });
    const outraInstancia = await createTenant({ slug: 'lab-evo-atacante' });
    slugToId.set('lab-evo-vitima', vitima.id);
    slugToId.set('lab-evo-atacante', outraInstancia.id);

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-vitima`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(outraInstancia.id), // instance ERRADA
          phone: '5548999998888',
          text: 'mensagem forjada',
        }),
      );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countMessages(vitima.id)).toBe(0);
  });

  it('instance AUSENTE no payload tambem e recusada', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-sem-instance' });
    slugToId.set('lab-evo-sem-instance', tenant.id);

    const payload = messagesUpsertPayload({
      instance: evolutionInstanceName(tenant.id),
      phone: '5548999998888',
      text: 'oi',
    });
    delete (payload as { instance?: unknown }).instance;

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-sem-instance`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(payload);

    expect(response.status).toBe(200);
    expect(await countMessages(tenant.id)).toBe(0);
  });

  it('tenant desconhecido e ignorado, com a mesma resposta', async () => {
    const payload = messagesUpsertPayload({
      instance: 'tenant-fantasma',
      phone: '5548999998888',
      text: 'oi',
    });
    const response = await app.agent
      .post(`${WEBHOOK}/lab-que-nao-existe`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it('payload malformado nao derruba o servidor', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-lixo' });
    slugToId.set('lab-evo-lixo', tenant.id);

    const lixos: unknown[] = [
      {},
      { event: 'MESSAGES_UPSERT', instance: evolutionInstanceName(tenant.id) },
      { event: 'MESSAGES_UPSERT', instance: evolutionInstanceName(tenant.id), data: { key: {} } },
      { event: 'MESSAGES_UPSERT', instance: evolutionInstanceName(tenant.id), data: null },
      [1, 2, 3],
    ];
    for (const lixo of lixos) {
      const response = await app.agent
        .post(`${WEBHOOK}/lab-evo-lixo`)
        .set('x-evolution-webhook-token', TOKEN)
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
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(alfa.id),
          phone: '5548999998888',
          text: 'oi alfa',
        }),
      )
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
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(evolutionInstanceName(tenant.id), 'open', '5511987654321'));

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

  it('state close NAO desativa o canal (is_active inalterado, API_CONTRACTS.md:2325) — so zera connected_at', async () => {
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
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(evolutionInstanceName(tenant.id), 'close'))
      .expect(200);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean; connected_at: Date | null }>(
        `SELECT is_active, connected_at FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    // Critical 1 da revisao: `is_active` e o MESMO kill switch que
    // `authenticateEvolution` confere antes do token. Se este evento o
    // apagasse, o proximo `CONNECTION_UPDATE state: 'open'` (reconexao por QR)
    // seria recusado pelo proprio kill switch e o canal travaria para sempre.
    expect(row.rows[0]?.is_active).toBe(true);
    expect(row.rows[0]?.connected_at).toBeNull();
  });

  it('reconectar apos close volta a aceitar MESSAGES_UPSERT — prova end-to-end do Critical 1', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-reconecta' });
    slugToId.set('lab-evo-reconecta', tenant.id);
    const instance = evolutionInstanceName(tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active, connected_at)
         VALUES ($1, 'whatsapp', 'qr', TRUE, NOW())`,
        [tenant.id],
      ),
    );

    // 1) O celular e desconectado (ou o admin desconecta) — `state: 'close'`.
    await app.agent
      .post(`${WEBHOOK}/lab-evo-reconecta`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(instance, 'close'))
      .expect(200);

    // 2) O admin re-escaneia o QR e o gateway confirma o pareamento.
    await app.agent
      .post(`${WEBHOOK}/lab-evo-reconecta`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(instance, 'open', '5511987654321'))
      .expect(200);

    // 3) Uma mensagem do paciente TEM que ser aceita — se o kill switch tivesse
    // ficado preso em `is_active = FALSE` depois do passo 1, isto falharia
    // silenciosamente com 200 e zero mensagens gravadas (Critical 1).
    await app.agent
      .post(`${WEBHOOK}/lab-evo-reconecta`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance,
          phone: '5548999998888',
          text: 'mensagem depois de reconectar',
        }),
      )
      .expect(200);

    expect(await countMessages(tenant.id)).toBe(1);
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
      .set('x-evolution-webhook-token', TOKEN)
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
