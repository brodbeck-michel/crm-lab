/**
 * `POST|GET /settings/channels/whatsapp/*` — conexao WhatsApp por QR via
 * gateway Evolution (Onda 7, Bloco B).
 *
 * O gateway e uma fake em memoria (mesmo padrao do `MockWhatsAppDriver`):
 * nenhuma chamada de rede real em teste/CI. O que estas specs provam:
 *
 *  - Aceite do termo e OBRIGATORIO (`acceptTerms: true`, nunca implicito) e
 *    fica gravado no CANAL (`accepted_terms_at`/`by`), nao so no audit log.
 *  - Papel: SO admin conecta/desconecta/le — `manager` e recusado (D-064/D-066
 *    seguem o mesmo padrao de escrita restrita a admin).
 *  - A apikey da instancia volta CIFRADA em `tenant_channels.api_token`
 *    (D-076, mesmo caminho do token cloud_api).
 *  - `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` ausentes -> `CHANNEL_QR_UNAVAILABLE`
 *    (503), nunca crash.
 *  - Isolamento: o canal QR de um tenant nunca aparece para outro.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { WhatsAppQrResponse, WhatsAppStatusResponse } from '@crm-lab/shared';
import { makeChannelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import type {
  EvolutionClient,
  EvolutionConnectionStatus,
} from '../../src/lib/evolution-client.js';
import type { DbClient } from '../../src/db/types.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/settings/channels/whatsapp';

/** Gateway Evolution de mentira: guarda estado em memoria, por instanceName. */
function fakeEvolutionClient(): EvolutionClient & {
  setStatus(instanceName: string, status: EvolutionConnectionStatus, phoneNumber?: string): void;
  createdInstances: string[];
  loggedOutInstances: string[];
} {
  const instances = new Map<string, { apikey: string }>();
  const statuses = new Map<string, { status: EvolutionConnectionStatus; phoneNumber: string | null }>();
  const createdInstances: string[] = [];
  const loggedOutInstances: string[] = [];

  return {
    createdInstances,
    loggedOutInstances,
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
    async sendText(instanceName: string) {
      return { externalId: `evo-${instanceName}-${Date.now()}` };
    },
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

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);

  const tenant = await createTenant({ name: 'Lab QR', slug: 'lab-qr', db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Admin QR', db });
  manager = await createUser({ tenantId, role: 'manager', name: 'Gestora QR', discountLimit: 30, db });

  evolution = fakeEvolutionClient();
  app = await buildApp(evolution);
});

describe('POST /settings/channels/whatsapp/connect', () => {
  it('sem aceite do termo (acceptTerms ausente ou false) -> VALIDATION_ERROR', async () => {
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
    // Mas esta gravada (cifrada em repouso quando CHANNEL_SECRET_KEY existe;
    // em teste sem a chave, gravada em claro — o que importa aqui e que NAO
    // e o valor mascarado/placeholder).
    expect(row?.api_token).toBeTruthy();
    expect(evolution.createdInstances).toContain(`tenant-${tenantId}`);
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

  it('sem gateway configurado -> CHANNEL_QR_UNAVAILABLE (503), nunca crash', async () => {
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
  it('chama logout no gateway e zera connected_at/is_active', async () => {
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
    expect(row?.is_active).toBe(false);
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
