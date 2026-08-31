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
  createTenantCredentialsResolver,
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

  it('sequencia close -> open -> mensagem (smoke test, NAO a prova do kill switch — ver descricao abaixo)', async () => {
    // CORRECAO da re-revisao da Task 5: o report da rodada 1 afirmava que este
    // teste "teria pego a regressao" do Critical 1. Isso e FALSO e a
    // afirmacao foi removida — `evolutionCredentialsResolver` acima calcula
    // `isActive` de um `Set` em memoria e NUNCA le `tenant_channels`, entao
    // reintroduzir `is_active = FALSE` em `markWhatsAppDisconnected` NAO
    // derrubaria este teste (a fake continuaria devolvendo `isActive: true`
    // não importa o que a coluna diga). Quem prova o mecanismo do Critical 1
    // sao as DUAS asserções diretas de coluna acima ("state close NAO
    // desativa...") e o teste grounded na coluna REAL logo abaixo. Este teste
    // fica como smoke test da SEQUENCIA (close -> open -> mensagem passa),
    // nao como regressao do kill switch.
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

    await app.agent
      .post(`${WEBHOOK}/lab-evo-reconecta`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(instance, 'close'))
      .expect(200);

    await app.agent
      .post(`${WEBHOOK}/lab-evo-reconecta`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(instance, 'open', '5511987654321'))
      .expect(200);

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

describe('kill switch — GROUNDED na coluna real de tenant_channels.is_active', () => {
  it('is_active = FALSE gravado direto no banco recusa o webhook, mesmo com token valido', async () => {
    // M9 da re-revisao: o teste de kill switch da rodada 1 exercitava so a
    // FAKE (`evolutionCredentialsResolver`, `disabled: Set`), nunca a coluna.
    // Este teste usa o RESOLVER DE PRODUCAO (`createTenantCredentialsResolver`,
    // o MESMO que `createWhatsAppService` usa fora de teste) contra uma linha
    // de `tenant_channels` gravada DIRETO — a unica forma de provar que
    // `is_active = FALSE` na tabela de verdade chega ate `authenticateEvolution`.
    // Se alguem reintroduzir `is_active = FALSE` em
    // `markWhatsAppDisconnected` amanha, este teste continua passando (nao e
    // o que ele prova); o que ele prova e o elo OPOSTO: que a coluna, quando
    // desligada, desliga o webhook.
    const tenant = await createTenant({ slug: 'lab-evo-kill-switch-real' });
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active)
         VALUES ($1, 'whatsapp', 'qr', FALSE)`,
        [tenant.id],
      ),
    );

    const realApp = await createTestApp({
      db,
      modules: [
        makeWebhookModule({
          whatsapp: new WhatsAppService({
            credentials: createTenantCredentialsResolver(db),
            driver: new MockWhatsAppDriver(),
            queue: createInMemoryQueue({ sleep: async () => undefined }),
          }),
        }),
      ],
    });

    const response = await realApp.agent
      .post(`${WEBHOOK}/lab-evo-kill-switch-real`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(tenant.id),
          phone: '5548999998888',
          text: 'canal desligado de verdade',
        }),
      );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countMessages(tenant.id)).toBe(0);
    expect(await countConversations(tenant.id)).toBe(0);
  });

  it('is_active = TRUE gravado direto no banco aceita — controle positivo do teste acima', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-kill-switch-ligado' });
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active)
         VALUES ($1, 'whatsapp', 'qr', TRUE)`,
        [tenant.id],
      ),
    );

    const realApp = await createTestApp({
      db,
      modules: [
        makeWebhookModule({
          whatsapp: new WhatsAppService({
            credentials: createTenantCredentialsResolver(db),
            driver: new MockWhatsAppDriver(),
            queue: createInMemoryQueue({ sleep: async () => undefined }),
          }),
        }),
      ],
    });

    await realApp.agent
      .post(`${WEBHOOK}/lab-evo-kill-switch-ligado`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(
        messagesUpsertPayload({
          instance: evolutionInstanceName(tenant.id),
          phone: '5548999998888',
          text: 'canal ligado de verdade',
        }),
      )
      .expect(200);

    expect(await countMessages(tenant.id)).toBe(1);
  });
});

describe('POST /webhooks/evolution/:tenant/status', () => {
  // I4 da re-revisao da Task 5: `/status` grava o MESMO efeito que
  // `evolutionInbound` (`markWhatsAppConnected`/`Disconnected`), e a rodada 1
  // so aplicou a checagem de `instance` na rota principal — era possivel
  // contornar a mitigacao inteira so acrescentando `/status` na URL. Estes
  // testes provam que a MESMA checagem agora vale aqui tambem, nos dois
  // formatos de payload que a rota aceita.

  it('payload achatado COM instance certo e atualiza o estado', async () => {
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
      .send({
        instance: evolutionInstanceName(tenant.id),
        state: 'open',
        owner: '5511987654321@s.whatsapp.net',
      })
      .expect(200);

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean }>(
        `SELECT is_active FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    expect(row.rows[0]?.is_active).toBe(true);
  });

  it('payload achatado SEM instance e recusado — nao grava nada', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-status-sem-instance' });
    slugToId.set('lab-evo-status-sem-instance', tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active)
         VALUES ($1, 'whatsapp', 'qr', FALSE)`,
        [tenant.id],
      ),
    );

    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-status-sem-instance/status`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({ state: 'open', owner: '5511987654321@s.whatsapp.net' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean }>(
        `SELECT is_active FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenant.id],
      ),
    );
    // Continua FALSE: sem `instance`, o evento nao pode religar um canal que
    // o admin desligou (era exatamente isto que o bypass explorava).
    expect(row.rows[0]?.is_active).toBe(false);
  });

  it('instance de OUTRO tenant e recusado, mesmo com token valido — bypass da rodada 1 fechado', async () => {
    const vitima = await createTenant({ slug: 'lab-evo-status-vitima' });
    const outraInstancia = await createTenant({ slug: 'lab-evo-status-atacante' });
    slugToId.set('lab-evo-status-vitima', vitima.id);
    slugToId.set('lab-evo-status-atacante', outraInstancia.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, is_active)
         VALUES ($1, 'whatsapp', 'qr', FALSE)`,
        [vitima.id],
      ),
    );

    // Este e exatamente o bypass que a re-revisao apontou: recusado na rota
    // principal (instance errada), o mesmo payload continuava passando so
    // com `/status` no fim da URL, antes deste fix.
    const response = await app.agent
      .post(`${WEBHOOK}/lab-evo-status-vitima/status`)
      .set('x-evolution-webhook-token', TOKEN)
      .send({
        instance: evolutionInstanceName(outraInstancia.id), // instance ERRADA
        state: 'open',
        owner: '5511987654321@s.whatsapp.net',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });

    const row = await db.withoutTenant((tx) =>
      tx.query<{ is_active: boolean }>(
        `SELECT is_active FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [vitima.id],
      ),
    );
    // O canal que o admin desligou continua desligado — nao foi
    // silenciosamente reativado por quem so tinha o token da instalacao.
    expect(row.rows[0]?.is_active).toBe(false);
  });

  it('envelope { event: CONNECTION_UPDATE, data, instance } tambem exige instance certo', async () => {
    const tenant = await createTenant({ slug: 'lab-evo-status-envelope' });
    slugToId.set('lab-evo-status-envelope', tenant.id);
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode) VALUES ($1, 'whatsapp', 'qr')`,
        [tenant.id],
      ),
    );

    await app.agent
      .post(`${WEBHOOK}/lab-evo-status-envelope/status`)
      .set('x-evolution-webhook-token', TOKEN)
      .send(connectionUpdatePayload(evolutionInstanceName(tenant.id), 'open', '5511987654321'))
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
