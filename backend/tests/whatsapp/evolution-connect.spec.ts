/**
 * `POST|GET /settings/channels/whatsapp/*` — conexao WhatsApp por QR via
 * gateway Evolution (Onda 7, Bloco B).
 *
 * O gateway e uma fake em memoria (mesmo padrao do `MockWhatsAppDriver`):
 * nenhuma chamada de rede real em teste/CI. O que estas specs provam:
 *
 *  - Aceite do termo: `acceptTerms: true` NESTE corpo OU `accepted_terms_at`
 *    ja gravado de uma conexao anterior (API_CONTRACTS.md:2260-2266) — nunca
 *    os dois ausentes. Fica gravado no CANAL (`accepted_terms_at`/`by`), nao
 *    so no audit log, e SOBREVIVE a reconexoes (nao e sobrescrito).
 *  - Papel: SO admin conecta/desconecta/le — `manager` e recusado (D-064/D-066
 *    seguem o mesmo padrao de escrita restrita a admin).
 *  - A apikey da instancia volta CIFRADA em `tenant_channels.api_token`
 *    (D-076, mesmo caminho do token cloud_api) — provado com
 *    `CHANNEL_SECRET_KEY` configurada, nao so por `toBeTruthy()`.
 *  - `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/`EVOLUTION_WEBHOOK_TOKEN`
 *    ausentes -> `CHANNEL_QR_UNAVAILABLE` (503), nunca crash (as TRES, nao so
 *    as duas do cliente HTTP — Important 3 da revisao da Task 5).
 *  - `disconnect` NUNCA mexe em `is_active` (Critical 1 — `is_active` e o
 *    kill switch do webhook; desligar e um controle separado,
 *    `PATCH /settings/channels`).
 *  - Auditoria das tres acoes (`accept_whatsapp_qr_terms`, `connect_whatsapp_qr`,
 *    `disconnect_whatsapp`) sem apikey/QR no `new_values` (Regra 7 e D-064).
 *  - Isolamento: o canal QR de um tenant nunca aparece para outro.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WhatsAppQrResponse, WhatsAppStatusResponse } from '@crm-lab/shared';
import { makeChannelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import type {
  EvolutionClient,
  EvolutionConnectionStatus,
} from '../../src/lib/evolution-client.js';
import type { DbClient } from '../../src/db/types.js';
import { EvolutionWhatsAppDriver, type WhatsAppCredentials } from '../../src/services/whatsapp.service.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/settings/channels/whatsapp';
const WEBHOOK_TOKEN = 'evolution-webhook-token-de-teste';

/** Gateway Evolution de mentira: guarda estado em memoria, por instanceName. */
function fakeEvolutionClient(): EvolutionClient & {
  setStatus(instanceName: string, status: EvolutionConnectionStatus, phoneNumber?: string): void;
  createdInstances: string[];
  loggedOutInstances: string[];
  lastSendApikey: string | undefined;
} {
  const instances = new Map<string, { apikey: string }>();
  const statuses = new Map<string, { status: EvolutionConnectionStatus; phoneNumber: string | null }>();
  const createdInstances: string[] = [];
  const loggedOutInstances: string[] = [];
  let lastSendApikey: string | undefined;

  return {
    createdInstances,
    loggedOutInstances,
    get lastSendApikey() {
      return lastSendApikey;
    },
    setStatus(instanceName, status, phoneNumber) {
      statuses.set(instanceName, { status, phoneNumber: phoneNumber ?? null });
    },
    async createInstance(instanceName: string) {
      createdInstances.push(instanceName);
      const apikey = `apikey-${instanceName}`;
      instances.set(instanceName, { apikey });
      statuses.set(instanceName, { status: 'pairing', phoneNumber: null });
      return { instanceName, apikey };
    },
    async getQr(instanceName: string) {
      const current = statuses.get(instanceName) ?? { status: 'pairing' as const, phoneNumber: null };
      return {
        qrcode: current.status === 'pairing' ? 'data:image/png;base64,QR' : null,
        status: current.status,
      };
    },
    async getStatus(instanceName: string) {
      const current = statuses.get(instanceName) ?? { status: 'disconnected' as const, phoneNumber: null };
      return current;
    },
    async logout(instanceName: string) {
      loggedOutInstances.push(instanceName);
      statuses.set(instanceName, { status: 'disconnected', phoneNumber: null });
    },
    async sendText(instanceName: string, _phone: string, _text: string, apikey: string) {
      lastSendApikey = apikey;
      return { externalId: `evo-${instanceName}-${Date.now()}` };
    },
    async sendMedia(instanceName: string, _phone, _media, apikey: string) {
      lastSendApikey = apikey;
      return { externalId: `evo-media-${instanceName}-${Date.now()}` };
    },
  };
}

/**
 * Gateway que responde como o Evolution de verdade quando a instancia sumiu
 * (container recriado, banco do gateway limpo, admin apagou pelo manager):
 * `404 ... instance does not exist`. Antes do fix isso virava 500 e a tela
 * travava sem conseguir reconectar.
 */
function missingInstanceClient(): EvolutionClient {
  const notFound = () =>
    Promise.reject(
      new Error(
        'Evolution API respondeu 404 em /instance/connect/tenant-x: {"status":404,"response":{"message":["The "tenant-x" instance does not exist"]}}',
      ),
    );
  return {
    createInstance: async (instanceName: string) => ({
      instanceName,
      apikey: `apikey-${instanceName}`,
    }),
    getQr: notFound,
    getStatus: notFound,
    logout: notFound,
    sendText: async () => ({ externalId: 'x' }),
    sendMedia: async () => ({ externalId: 'x' }),
  };
}

/** Gateway fora do ar: qualquer chamada estoura com erro que NAO e 404. */
function brokenGatewayClient(): EvolutionClient {
  const boom = () => Promise.reject(new Error('Evolution API respondeu 502 em /instance/connect'));
  return {
    createInstance: boom,
    getQr: boom,
    getStatus: boom,
    logout: boom,
    sendText: async () => ({ externalId: 'x' }),
    sendMedia: async () => ({ externalId: 'x' }),
  };
}

let db: DbClient;
let app: TestApp;
let admin: UserRecord;
let manager: UserRecord;
let tenantId: string;
let evolution: ReturnType<typeof fakeEvolutionClient>;

async function buildApp(client: EvolutionClient = fakeEvolutionClient()): Promise<TestApp> {
  return createTestApp({
    db,
    modules: [makeChannelSettingsModule({ evolutionClient: client })],
  });
}

async function rawChannelState(target: string): Promise<
  | {
      connection_mode: string;
      accepted_terms_at: Date | null;
      accepted_terms_by: string | null;
      api_token: string | null;
      is_active: boolean;
      connected_at: Date | null;
    }
  | undefined
> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      connection_mode: string;
      accepted_terms_at: Date | null;
      accepted_terms_by: string | null;
      api_token: string | null;
      is_active: boolean;
      connected_at: Date | null;
    }>(
      `SELECT connection_mode, accepted_terms_at, accepted_terms_by, api_token, is_active, connected_at
         FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
      [target],
    ),
  );
  return result.rows[0];
}

async function auditActions(target: string): Promise<
  Array<{ action: string; user_id: string | null; new_values: unknown }>
> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ action: string; user_id: string | null; new_values: unknown }>(
      `SELECT action, user_id, new_values FROM audit_logs WHERE tenant_id = $1 ORDER BY "timestamp" ASC`,
      [target],
    ),
  );
  return result.rows;
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);

  const tenant = await createTenant({ name: 'Lab QR', slug: 'lab-qr', db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Admin QR', db });
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora QR', discountLimit: 30, db });

  // Important 3 da revisao: as 4 rotas exigem TAMBEM o token do webhook, nao
  // so URL/KEY do cliente — sem ele o admin nao consegue nem comecar a parear
  // um numero que depois nao vai receber nada.
  process.env.EVOLUTION_WEBHOOK_TOKEN = WEBHOOK_TOKEN;

  evolution = fakeEvolutionClient();
  app = await buildApp(evolution);
});

afterEach(() => {
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
  delete process.env.CHANNEL_SECRET_KEY;
});

describe('POST /settings/channels/whatsapp/connect', () => {
  it('sem aceite do termo (acceptTerms ausente ou false) e SEM aceite previo -> VALIDATION_ERROR', async () => {
    const semCampo = await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({}).expect(400);
    expect(semCampo.body.error.code).toBe('VALIDATION_ERROR');
    expect(semCampo.body.error.details.fields).toHaveProperty('acceptTerms');

    const falso = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(admin))
      .send({ acceptTerms: false })
      .expect(400);
    expect(falso.body.error.code).toBe('VALIDATION_ERROR');

    // Nada foi gravado nem chamado no gateway.
    expect(await rawChannelState(tenantId)).toBeUndefined();
    expect(evolution.createdInstances).toHaveLength(0);
  });

  it('com aceite grava accepted_terms_at/by, cria a instancia e devolve o QR', async () => {
    const res = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(admin))
      .send({ acceptTerms: true })
      .expect(200);

    const body = res.body as WhatsAppQrResponse;
    expect(body.status).toBe('pairing');
    expect(body.qrcode).not.toBeNull();
    expect(body.expiresInSeconds).toBeGreaterThan(0);

    const row = await rawChannelState(tenantId);
    expect(row?.connection_mode).toBe('qr');
    expect(row?.accepted_terms_at).not.toBeNull();
    expect(row?.accepted_terms_by).toBe(admin.id);
    // A apikey em claro NUNCA aparece no corpo da resposta.
    expect(JSON.stringify(res.body)).not.toContain('apikey-tenant');
    expect(row?.api_token).toBeTruthy();
    expect(evolution.createdInstances).toContain(`tenant-${tenantId}`);
  });

  it('apikey da instancia e CIFRADA em repouso quando CHANNEL_SECRET_KEY existe (D-076)', async () => {
    // M9 (parcial) da revisao: `toBeTruthy()` nao prova cifra — qualquer
    // string nao vazia passa. Aqui a chave e configurada de verdade e o valor
    // gravado e comparado contra o texto em claro que o fake gateway devolveu.
    process.env.CHANNEL_SECRET_KEY = 'chave-de-teste-com-mais-de-32-caracteres-000';

    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);

    const row = await rawChannelState(tenantId);
    const plaintext = `apikey-tenant-${tenantId}`;
    expect(row?.api_token).not.toBe(plaintext);
    expect(row?.api_token).not.toBeNull();
    expect(row?.api_token?.startsWith('enc:v1:')).toBe(true);
  });

  it('reconectar SEM acceptTerms no corpo funciona quando ja aceito antes, e NAO reescreve accepted_terms_at/by', async () => {
    // Important 5 da revisao: API_CONTRACTS.md:2260-2266 — aceite previo OU
    // `acceptTerms: true` neste corpo. O frontend de reconexao le
    // `acceptedTermsAt` de `GET /settings/channels`, ve que ja foi aceito, e
    // esta autorizado a pular o checkbox e mandar `{}`.
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    const primeiraAceite = (await rawChannelState(tenantId))?.accepted_terms_at;
    expect(primeiraAceite).not.toBeNull();

    const outroAdmin = await createUser({ tenantId, role: 'admin', name: 'Outro Admin', db });
    const res = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(outroAdmin))
      .send({})
      .expect(200);
    expect((res.body as WhatsAppQrResponse).status).toBe('pairing');

    const row = await rawChannelState(tenantId);
    // O registro LGPD de QUEM/QUANDO aceitou pela primeira vez sobrevive.
    expect(row?.accepted_terms_at).toEqual(primeiraAceite);
    expect(row?.accepted_terms_by).toBe(admin.id);
  });

  it('gestor nao pode conectar (admin apenas) -> FORBIDDEN', async () => {
    const res = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(manager))
      .send({ acceptTerms: true })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(evolution.createdInstances).toHaveLength(0);
  });

  it('sem gateway configurado (URL/KEY) -> CHANNEL_QR_UNAVAILABLE (503), nunca crash', async () => {
    const semGateway = await createTestApp({
      db,
      modules: [makeChannelSettingsModule({})],
    });
    const res = await semGateway.agent
      .post(`${URL}/connect`)
      .set(semGateway.auth(admin))
      .send({ acceptTerms: true })
      .expect(503);
    expect(res.body.error.code).toBe('CHANNEL_QR_UNAVAILABLE');
  });

  it('sem EVOLUTION_WEBHOOK_TOKEN (gateway OK) -> CHANNEL_QR_UNAVAILABLE (503)', async () => {
    // Important 3: sem o token do webhook, um "conectado" nunca recebe nada —
    // o admin nao pode nem comecar.
    delete process.env.EVOLUTION_WEBHOOK_TOKEN;
    const res = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(admin))
      .send({ acceptTerms: true })
      .expect(503);
    expect(res.body.error.code).toBe('CHANNEL_QR_UNAVAILABLE');
    expect(evolution.createdInstances).toHaveLength(0);
  });
});

describe('GET /settings/channels/whatsapp/qr', () => {
  it('devolve o QR vigente do gateway', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);

    const res = await app.agent.get(`${URL}/qr`).set(app.auth(admin)).expect(200);
    const body = res.body as WhatsAppQrResponse;
    expect(body.status).toBe('pairing');
    expect(body.qrcode).toContain('base64');
  });
});

describe('GET /settings/channels/whatsapp/status', () => {
  it('reflete o estado connected do gateway, com telefone e connectedAt', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    evolution.setStatus(`tenant-${tenantId}`, 'connected', '5511987654321');
    // O connectedAt vem do BANCO (webhook CONNECTION_UPDATE grava); simula o
    // gateway ja tendo emitido o evento.
    await db.withTenant(tenantId, (tx) =>
      tx.query(
        `UPDATE tenant_channels SET connected_at = NOW(), phone_number = $2 WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenantId, '5511987654321'],
      ),
    );

    const res = await app.agent.get(`${URL}/status`).set(app.auth(admin)).expect(200);
    const body = res.body as WhatsAppStatusResponse;
    expect(body.status).toBe('connected');
    expect(body.phoneNumber).toBe('5511987654321');
    expect(body.connectedAt).not.toBeNull();
  });

  it('reflete loggedOut (close no gateway) como disconnected', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    evolution.setStatus(`tenant-${tenantId}`, 'disconnected');

    const res = await app.agent.get(`${URL}/status`).set(app.auth(admin)).expect(200);
    const body = res.body as WhatsAppStatusResponse;
    expect(body.status).toBe('disconnected');
    expect(body.connectedAt).toBeNull();
  });
});

describe('POST /settings/channels/whatsapp/disconnect', () => {
  it('chama logout no gateway e zera connected_at — is_active FICA INALTERADO (Critical 1, API_CONTRACTS.md:2325)', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    await db.withTenant(tenantId, (tx) =>
      tx.query(
        `UPDATE tenant_channels SET connected_at = NOW(), is_active = TRUE WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenantId],
      ),
    );

    await app.agent.post(`${URL}/disconnect`).set(app.auth(admin)).expect(204);

    expect(evolution.loggedOutInstances).toContain(`tenant-${tenantId}`);
    const row = await rawChannelState(tenantId);
    expect(row?.connected_at).toBeNull();
    // "Desconectar nao e desativar o canal na tela; sao dois controles
    // distintos." Um `markWhatsAppDisconnected` que apagasse `is_active`
    // travava o kill switch do webhook para sempre (Critical 1) — o unico
    // jeito de desligar de proposito e `PATCH /settings/channels`.
    expect(row?.is_active).toBe(true);
  });
});

describe('auditoria das 3 acoes (Regra 7)', () => {
  it('accept_whatsapp_qr_terms e connect_whatsapp_qr sao gravados no connect, sem apikey/QR', async () => {
    const res = await app.agent
      .post(`${URL}/connect`)
      .set(app.auth(admin))
      .send({ acceptTerms: true })
      .expect(200);

    const entries = await auditActions(tenantId);
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['accept_whatsapp_qr_terms', 'connect_whatsapp_qr']),
    );
    for (const entry of entries) {
      expect(entry.user_id).toBe(admin.id);
      const serialized = JSON.stringify(entry.new_values);
      expect(serialized).not.toContain('apikey-tenant');
      expect(serialized).not.toContain((res.body as WhatsAppQrResponse).qrcode ?? '__nunca__');
    }
  });

  it('reconectar sem novo aceite NAO duplica accept_whatsapp_qr_terms', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({}).expect(200);

    const entries = await auditActions(tenantId);
    const aceites = entries.filter((e) => e.action === 'accept_whatsapp_qr_terms');
    expect(aceites).toHaveLength(1);
  });

  it('disconnect_whatsapp e gravado', async () => {
    await app.agent.post(`${URL}/connect`).set(app.auth(admin)).send({ acceptTerms: true }).expect(200);
    await app.agent.post(`${URL}/disconnect`).set(app.auth(admin)).expect(204);

    const entries = await auditActions(tenantId);
    expect(entries.map((e) => e.action)).toContain('disconnect_whatsapp');
  });
});

describe('EvolutionWhatsAppDriver.send (Important 6 + N1)', () => {
  it('usa credentials.qrInstanceApiKey (a apikey DA INSTANCIA), nunca a apikey admin', async () => {
    const driver = new EvolutionWhatsAppDriver(evolution);
    const credentials: WhatsAppCredentials = {
      tenantId,
      phoneNumberId: 'numero-do-lab',
      apiUrl: '',
      apiToken: '',
      webhookSecret: '',
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: 'qr',
      qrInstanceApiKey: 'apikey-da-instancia-real',
    };

    await driver.send(credentials, '5511987654321', 'Ola');

    expect(evolution.lastSendApikey).toBe('apikey-da-instancia-real');
  });

  it('sem qrInstanceApiKey gravado, lanca em vez de sair com privilegio de admin', async () => {
    const driver = new EvolutionWhatsAppDriver(evolution);
    const credentials: WhatsAppCredentials = {
      tenantId,
      phoneNumberId: 'numero-do-lab',
      apiUrl: '',
      apiToken: '',
      webhookSecret: '',
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: 'qr',
      qrInstanceApiKey: null,
    };

    await expect(driver.send(credentials, '5511987654321', 'Ola')).rejects.toThrow();
    expect(evolution.lastSendApikey).toBeUndefined();
  });

  it('N1 da re-revisao: apiToken presente (fallback de OUTRO provedor) NUNCA vaza quando qrInstanceApiKey e null', async () => {
    // Reproduz exatamente o estado que a re-revisao apontou: uma linha
    // `connection_mode='qr'` sem apikey de instancia gravada (janela entre
    // aceitar o termo e `createInstance` ter sucesso), com `apiToken`
    // carregando o que seria o fallback de `WHATSAPP_API_TOKEN` (Meta, outro
    // provedor) se o merge de credenciais ainda tivesse esse `??` — o driver
    // tem que recusar independente do que `apiToken` contenha.
    const driver = new EvolutionWhatsAppDriver(evolution);
    const credentials: WhatsAppCredentials = {
      tenantId,
      phoneNumberId: 'numero-do-lab',
      apiUrl: '',
      apiToken: 'token-da-api-oficial-da-meta-NUNCA-pode-vazar',
      webhookSecret: '',
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: 'qr',
      qrInstanceApiKey: null,
    };

    await expect(driver.send(credentials, '5511987654321', 'Ola')).rejects.toThrow();
    // Nem o gateway fake recebeu a chamada, muito menos o segredo da Meta.
    expect(evolution.lastSendApikey).toBeUndefined();
  });
});

describe('isolamento entre dois laboratorios', () => {
  it('canal QR de B nao aparece para A', async () => {
    const outro = await createTenant({ name: 'Lab QR Beta', slug: 'lab-qr-beta', db });
    const adminB = await createUser({ tenantId: outro.id, role: 'admin', name: 'Admin B', db });

    await app.agent.post(`${URL}/connect`).set(app.auth(adminB)).send({ acceptTerms: true }).expect(200);

    expect(await rawChannelState(tenantId)).toBeUndefined();
    expect(evolution.createdInstances).toEqual([`tenant-${outro.id}`]);
  });
});

describe('instancia ausente no gateway (404) vs gateway fora do ar', () => {
  it('GET /status com a instancia ausente devolve disconnected, nunca 500', async () => {
    // Antes do fix: o `Error` do cliente subia cru ate o error-handler -> 500
    // com corpo vazio, e a tela de Canais travava sem permitir reconectar.
    app = await buildApp(missingInstanceClient());
    const res = await app.agent.get(`${URL}/status`).set(app.auth(admin)).expect(200);
    const body = res.body as WhatsAppStatusResponse;
    expect(body.status).toBe('disconnected');
    expect(body.connectedAt).toBeNull();
  });

  it('GET /qr com a instancia ausente devolve disconnected sem QR, nunca 500', async () => {
    app = await buildApp(missingInstanceClient());
    const res = await app.agent.get(`${URL}/qr`).set(app.auth(admin)).expect(200);
    const body = res.body as WhatsAppQrResponse;
    expect(body.status).toBe('disconnected');
    expect(body.qrcode).toBeNull();
  });

  it('DELETE /disconnect com a instancia ausente e idempotente (ja esta desconectado)', async () => {
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, connected_at)
         VALUES ($1, 'whatsapp', 'qr', now())`,
        [tenantId],
      ),
    );
    app = await buildApp(missingInstanceClient());
    await app.agent.post(`${URL}/disconnect`).set(app.auth(admin)).expect(204);
    expect((await rawChannelState(tenantId))?.connected_at).toBeNull();
  });

  it('gateway fora do ar (erro que NAO e 404) continua CHANNEL_QR_UNAVAILABLE', async () => {
    app = await buildApp(brokenGatewayClient());
    const res = await app.agent.get(`${URL}/status`).set(app.auth(admin)).expect(503);
    expect(res.body.error.code).toBe('CHANNEL_QR_UNAVAILABLE');

    const qr = await app.agent.get(`${URL}/qr`).set(app.auth(admin)).expect(503);
    expect(qr.body.error.code).toBe('CHANNEL_QR_UNAVAILABLE');
  });
});
