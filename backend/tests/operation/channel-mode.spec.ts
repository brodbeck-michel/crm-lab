/**
 * Modo do canal WhatsApp por laboratorio (CRMLAB-135, D-308; contrato API §6.2).
 *
 *  - Troca de modo vai por `PUT /settings/channels/whatsapp/mode`, nunca pelo PATCH.
 *  - Trocar de modo NAO toca nas mensagens e NAO chama o gateway.
 *  - O token da Cloud API nunca volta na resposta (JSON inteiro).
 *  - Envio sem configuracao valida e erro de negocio claro, com nomes de campo.
 *  - Troca de modo gera audit log; outro tenant nao e afetado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { BusinessError } from '../../src/http/errors.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  createTenantCredentialsResolver,
  type WhatsAppCredentials,
} from '../../src/services/whatsapp.service.js';
import { countMessages } from '../conversations/helpers.js';
import { createConversation, createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const URL = '/api/v1/settings/channels';
const MODE_URL = `${URL}/whatsapp/mode`;
const TOKEN = 'EAAG-cloud-token-em-claro-7c1d';

const ENV_FALLBACK: Omit<WhatsAppCredentials, 'tenantId'> = {
  phoneNumberId: 'mock',
  apiUrl: '',
  wabaId: '',
  apiToken: '',
  webhookSecret: '',
  isActive: true,
  apiTokenRevoked: false,
  connectionMode: 'cloud_api',
  qrInstanceApiKey: null,
};

const cloudFields = {
  phoneNumberId: '109876543210987',
  wabaId: '208765432109876',
  apiToken: TOKEN,
};

let db: DbClient;
let app: TestApp;
let admin: UserRecord;
let tenantId: string;

/** Grava credenciais da Cloud API pelo PATCH (que ainda aceita esses campos). */
function saveCloudFields(as: UserRecord = admin, fields = cloudFields) {
  return app.agent
    .patch(URL)
    .set(app.auth(as))
    .send({ channels: [{ channel: 'whatsapp', ...fields }] });
}

function putMode(mode: string, as: UserRecord = admin) {
  return app.agent.put(MODE_URL).set(app.auth(as)).send({ mode });
}

/** Linha em modo QR, com apikey da instancia Evolution e (opcional) termo aceito. */
async function setQrRow(target: string, apikey: string | null, accepted = true): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, api_token, accepted_terms_at)
       VALUES ($1, 'whatsapp', 'qr', $2, CASE WHEN $3 THEN now() END)
       ON CONFLICT (tenant_id, channel) DO UPDATE
         SET connection_mode = 'qr', api_token = $2,
             accepted_terms_at = CASE WHEN $3 THEN now() END`,
      [target, apikey, accepted],
    ),
  );
}

async function modeOf(target: string): Promise<string | null> {
  const row = await db.withoutTenant((tx) =>
    tx.query<{ connection_mode: string }>(
      `SELECT connection_mode FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
      [target],
    ),
  );
  return row.rows[0]?.connection_mode ?? null;
}

async function seedMessage(target: string): Promise<void> {
  const conversation = await createConversation({ tenantId: target, db });
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO messages (tenant_id, conversation_id, sender_type, content)
       VALUES ($1, $2, 'patient', 'oi, preciso de um orcamento')`,
      [target, conversation.id],
    ),
  );
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [channelSettingsModule] });
  const tenant = await createTenant({ name: 'Lab Vida', slug: 'lab-vida', db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Admin Ana', db });
});

describe('PUT /settings/channels/whatsapp/mode — qr -> cloud_api', () => {
  it('sem credenciais da Cloud API: 409 CHANNEL_CLOUD_API_NOT_CONFIGURED listando os campos, modo intacto', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    const res = await putMode('cloud_api').expect(409);
    expect(res.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect(res.body.error.details.missing).toEqual(
      expect.arrayContaining(['phoneNumberId', 'wabaId', 'apiToken']),
    );
    expect(await modeOf(tenantId)).toBe('qr');
  });

  it('a apikey do QR nunca vale como token da Meta: 409 mesmo com phone e waba gravados, mensagens intactas', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({
        channels: [
          { channel: 'whatsapp', phoneNumberId: cloudFields.phoneNumberId, wabaId: cloudFields.wabaId },
        ],
      })
      .expect(200);
    await seedMessage(tenantId);
    const before = await countMessages(tenantId);

    const res = await putMode('cloud_api').expect(409);
    expect(res.body.error.details.missing).toEqual(['apiToken']);
    expect(JSON.stringify(res.body)).not.toContain('apikey-evolution');
    expect(await modeOf(tenantId)).toBe('qr');
    expect(await countMessages(tenantId)).toBe(before);
  });

  it('connectionMode no PATCH e recusado (troca vai pelo PUT)', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', connectionMode: 'cloud_api' }] })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('channels.whatsapp.connectionMode');
    expect(await modeOf(tenantId)).toBe('qr');
  });

  it('modo invalido: 400 VALIDATION_ERROR', async () => {
    await putMode('evolution').expect(400);
  });

  it('mesmo modo e idempotente: 200 sem efeito e sem audit', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await putMode('qr').expect(200);
    const audit = await db.withoutTenant((tx) =>
      tx.query(`SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'update_whatsapp_mode'`, [
        tenantId,
      ]),
    );
    expect(audit.rows).toHaveLength(0);
  });
});

describe('PUT /settings/channels/whatsapp/mode — cloud_api -> qr', () => {
  it('sem termo de risco aceito: 400 VALIDATION_ERROR (acceptTerms)', async () => {
    await saveCloudFields().expect(200);
    const res = await putMode('qr').expect(400);
    expect(res.body.error.details.fields).toHaveProperty('acceptTerms');
    expect(await modeOf(tenantId)).not.toBe('qr');
  });

  it('com termo aceito antes: 200 e modo qr (pareamento continua em POST /connect)', async () => {
    await setQrRow(tenantId, 'apikey-evolution', true);
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE tenant_channels SET connection_mode = 'cloud_api' WHERE tenant_id = $1`, [
        tenantId,
      ]),
    );
    const res = await putMode('qr').expect(200);
    expect(res.body.connectionMode).toBe('qr');
    expect(await modeOf(tenantId)).toBe('qr');
  });
});

describe('token da Cloud API (write-only)', () => {
  it('nao aparece em nenhuma resposta, PATCH, PUT ou GET', async () => {
    const escrita = await saveCloudFields().expect(200);
    const modo = await putMode('cloud_api').expect(200);
    const leitura = await app.agent.get(URL).set(app.auth(admin)).expect(200);

    for (const body of [escrita.body, modo.body, leitura.body]) {
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
    expect(leitura.body.channels[0].apiTokenMasked).toBe(`••••••••${TOKEN.slice(-4)}`);
  });
});

describe('isolamento', () => {
  it('trocar o modo de um laboratorio nao toca no outro', async () => {
    const other = await createTenant({ name: 'Lab Sol', slug: 'lab-sol', db });
    await setQrRow(other.id, 'apikey-outro');
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE tenant_channels SET connection_mode = 'cloud_api' WHERE tenant_id = $1`, [
        other.id,
      ]),
    );
    await setQrRow(tenantId, 'apikey-evolution', true);
    await db.withoutTenant((tx) =>
      tx.query(`UPDATE tenant_channels SET connection_mode = 'cloud_api' WHERE tenant_id = $1`, [
        tenantId,
      ]),
    );
    await putMode('qr').expect(200);

    expect(await modeOf(tenantId)).toBe('qr');
    expect(await modeOf(other.id)).toBe('cloud_api');
  });
});

describe('envio sem configuracao valida', () => {
  const build = (fallback: Omit<WhatsAppCredentials, 'tenantId'>) =>
    new WhatsAppService({
      credentials: createTenantCredentialsResolver(db, { fallback }),
      driver: new MockWhatsAppDriver(),
      queue: createInMemoryQueue({ sleep: async () => undefined }),
    });

  it('modo qr sem apikey de instancia: CHANNEL_QR_UNAVAILABLE', async () => {
    await setQrRow(tenantId, null);
    const err = await build(ENV_FALLBACK)
      .send(tenantId, '5548999990000', 'oi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('CHANNEL_QR_UNAVAILABLE');
  });

  it('cloud_api sem phone_number_id com API real configurada: CHANNEL_CLOUD_API_NOT_CONFIGURED', async () => {
    const err = await build({
      ...ENV_FALLBACK,
      apiUrl: 'https://graph.test',
      apiToken: 'token-do-lab',
      wabaId: 'waba-do-lab',
      phoneNumberId: '',
    })
      .send(tenantId, '5548999990000', 'oi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect((err as BusinessError).details?.missing).toEqual(expect.arrayContaining(['phoneNumberId']));
  });
});
