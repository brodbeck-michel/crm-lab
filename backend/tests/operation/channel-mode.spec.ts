/**
 * Modo do canal WhatsApp por laboratorio (CRMLAB-135, D-308; contrato API §6.2).
 *
 *  - Troca de modo vai por `PUT /settings/channels/whatsapp/mode`, nunca pelo PATCH.
 *  - Trocar de modo NAO toca nas mensagens e NAO chama o gateway.
 *  - O token da Cloud API nunca volta na resposta (JSON inteiro).
 *  - Envio sem configuracao valida e erro de negocio claro, com nomes de campo.
 *  - Troca de modo gera audit log; outro tenant nao e afetado.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
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

async function rawTokens(
  target: string,
): Promise<{ api_token: string | null; cloud_api_token: string | null }> {
  const row = await db.withoutTenant((tx) =>
    tx.query<{ api_token: string | null; cloud_api_token: string | null }>(
      `SELECT api_token, cloud_api_token FROM tenant_channels
        WHERE tenant_id = $1 AND channel = 'whatsapp'`,
      [target],
    ),
  );
  return row.rows[0] ?? { api_token: null, cloud_api_token: null };
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

const ORIGINAL_API_URL = env.WHATSAPP_API_URL;

beforeEach(async () => {
  // Instalacao com a API real configurada: o PUT /mode exige as credenciais.
  // O caso do mock (URL vazia) tem teste proprio abaixo.
  env.WHATSAPP_API_URL = 'https://graph.test';
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

  it('com as tres credenciais da Meta: 200, modo cloud_api, audit so com o modo e apikey do QR preservada', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await seedMessage(tenantId);
    const before = await countMessages(tenantId);
    await saveCloudFields().expect(200);

    const res = await putMode('cloud_api').expect(200);
    expect(res.body).toEqual({ connectionMode: 'cloud_api', cloudApiConfigured: true });
    expect(await modeOf(tenantId)).toBe('cloud_api');
    expect(await countMessages(tenantId)).toBe(before);

    // D-308 item 3: o token da Meta foi para a coluna propria e a apikey do QR
    // continua onde estava — voltar para `qr` nao exige parear de novo.
    const raw = await rawTokens(tenantId);
    expect(raw.api_token).toBe('apikey-evolution');
    expect(raw.cloud_api_token).toBe(TOKEN);

    const audit = await db.withoutTenant((tx) =>
      tx.query<{ old_values: unknown; new_values: unknown }>(
        `SELECT old_values, new_values FROM audit_logs
          WHERE tenant_id = $1 AND action = 'update_whatsapp_mode'`,
        [tenantId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.old_values).toEqual({ connectionMode: 'qr' });
    expect(audit.rows[0]?.new_values).toEqual({ connectionMode: 'cloud_api' });
    expect(JSON.stringify(audit.rows)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.rows)).not.toContain('apikey-evolution');
  });

  it('a apikey do QR nunca vale como token da Meta: so phone e waba gravados = 409 com missing [apiToken]', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await saveCloudFields(admin, {
      phoneNumberId: cloudFields.phoneNumberId,
      wabaId: cloudFields.wabaId,
    } as typeof cloudFields).expect(200);

    const res = await putMode('cloud_api').expect(409);
    expect(res.body.error.details).toEqual({ missing: ['apiToken'] });
    expect(JSON.stringify(res.body)).not.toContain('apikey-evolution');
    expect(await modeOf(tenantId)).toBe('qr');
  });

  it('gravar o token da Meta em qr nao sobrescreve a apikey da instancia Evolution', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await saveCloudFields().expect(200);
    const raw = await rawTokens(tenantId);
    expect(raw.api_token).toBe('apikey-evolution');
    expect(raw.cloud_api_token).toBe(TOKEN);
    expect(await modeOf(tenantId)).toBe('qr');
  });

  it.each(['attendant', 'manager'] as const)('%s: 403 FORBIDDEN com requiredRoles [admin], modo intacto', async (role) => {
    await setQrRow(tenantId, 'apikey-evolution');
    await saveCloudFields().expect(200);
    const user = await createUser({ tenantId, role, name: `Usuario ${role}`, db });
    const res = await putMode('cloud_api', user).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details.requiredRoles).toEqual(['admin']);
    expect(await modeOf(tenantId)).toBe('qr');
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

  it('campo desconhecido no corpo: 400 VALIDATION_ERROR com o nome do campo', async () => {
    const res = await app.agent
      .put(MODE_URL)
      .set(app.auth(admin))
      .send({ mode: 'cloud_api', force: true })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('force');
  });

  it('wabaId em canal que nao e whatsapp: 400', async () => {
    const res = await app.agent
      .patch(URL)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'sms', wabaId: '123' }] })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty('channels.sms.wabaId');
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

afterEach(() => {
  env.WHATSAPP_API_URL = ORIGINAL_API_URL;
});

describe('PUT /settings/channels/whatsapp/mode — mock (sem WHATSAPP_API_URL)', () => {
  it('qr -> cloud_api sem credencial: 200, porque nada sai de verdade (hml de treinamento)', async () => {
    env.WHATSAPP_API_URL = '';
    await setQrRow(tenantId, 'apikey-evolution');
    const res = await putMode('cloud_api').expect(200);
    expect(res.body).toEqual({ connectionMode: 'cloud_api', cloudApiConfigured: false });
    expect(await modeOf(tenantId)).toBe('cloud_api');
  });

  it('URL so de espacos tambem e mock', async () => {
    env.WHATSAPP_API_URL = '   ';
    await setQrRow(tenantId, 'apikey-evolution');
    await putMode('cloud_api').expect(200);
  });
});

describe('PUT /settings/channels/whatsapp/mode — guardas', () => {
  it('platform_operator: 403 pelo guard de plataforma, modo intacto', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    const plataforma = await createTenant({ name: 'Plataforma', slug: 'plat', db });
    const operador = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
    const res = await putMode('cloud_api', operador).expect(403);
    expect(res.body.error.details.requiredRoles).toEqual(['attendant', 'manager', 'admin']);
    expect(await modeOf(tenantId)).toBe('qr');
  });
});

describe('PATCH do token da Meta em qr nao mexe no pareamento', () => {
  it('connected_at do QR desconectado continua NULL', async () => {
    await setQrRow(tenantId, 'apikey-evolution');
    await saveCloudFields().expect(200);
    const row = await db.withoutTenant((tx) =>
      tx.query<{ connected_at: unknown }>(
        `SELECT connected_at FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenantId],
      ),
    );
    expect(row.rows[0]?.connected_at).toBeNull();
  });

  it('em cloud_api o primeiro token gravado marca connected_at', async () => {
    await saveCloudFields().expect(200);
    const row = await db.withoutTenant((tx) =>
      tx.query<{ connected_at: unknown }>(
        `SELECT connected_at FROM tenant_channels WHERE tenant_id = $1 AND channel = 'whatsapp'`,
        [tenantId],
      ),
    );
    expect(row.rows[0]?.connected_at).not.toBeNull();
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
    await seedMessage(tenantId);
    const before = await countMessages(tenantId);
    const res = await putMode('qr').expect(200);
    expect(res.body.connectionMode).toBe('qr');
    expect(await modeOf(tenantId)).toBe('qr');
    // Trocar de modo nao apaga nada (D-308 item 2).
    expect(await countMessages(tenantId)).toBe(before);
  });

  it('ida e volta: cloud_api -> qr -> cloud_api sem digitar credenciais de novo', async () => {
    await setQrRow(tenantId, 'apikey-evolution', true);
    await saveCloudFields().expect(200);
    await putMode('cloud_api').expect(200);
    await putMode('qr').expect(200);
    const res = await putMode('cloud_api').expect(200);
    expect(res.body.cloudApiConfigured).toBe(true);
    expect((await rawTokens(tenantId)).api_token).toBe('apikey-evolution');
  });
});

describe('GET /settings/channels — cloudApiConfigured', () => {
  it('false sem as tres credenciais; true com elas; apiTokenMasked e o da Meta, nunca a apikey do QR', async () => {
    await setQrRow(tenantId, 'apikey-evolution-9z8y');
    let res = await app.agent.get(URL).set(app.auth(admin)).expect(200);
    let whatsapp = res.body.channels.find((c: { channel: string }) => c.channel === 'whatsapp');
    expect(whatsapp.cloudApiConfigured).toBe(false);
    expect(whatsapp.apiTokenMasked).toBeNull();

    await saveCloudFields().expect(200);
    res = await app.agent.get(URL).set(app.auth(admin)).expect(200);
    whatsapp = res.body.channels.find((c: { channel: string }) => c.channel === 'whatsapp');
    expect(whatsapp.cloudApiConfigured).toBe(true);
    expect(whatsapp.wabaId).toBe(cloudFields.wabaId);
    expect(whatsapp.apiTokenMasked).toBe(`••••••••${TOKEN.slice(-4)}`);
    expect(JSON.stringify(res.body)).not.toContain('apikey-evolution');
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

  it('D-308 item 5: credencial da instalacao (env) nao completa a do laboratorio', async () => {
    // So o WABA gravado; a env traz numero e token de outra conta.
    await saveCloudFields(admin, { wabaId: cloudFields.wabaId } as typeof cloudFields).expect(200);
    const err = await build({
      ...ENV_FALLBACK,
      apiUrl: 'https://graph.test',
      phoneNumberId: 'numero-da-instalacao',
      apiToken: 'token-da-instalacao',
    })
      .send(tenantId, '5548999990000', 'oi')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect((err as BusinessError).details?.missing).toEqual(['phoneNumberId', 'apiToken']);
  });

  it('cloud_api sem wabaId e sem token: missing lista os dois', async () => {
    await saveCloudFields(admin, { phoneNumberId: cloudFields.phoneNumberId } as typeof cloudFields).expect(200);
    const err = await build({ ...ENV_FALLBACK, apiUrl: 'https://graph.test' })
      .send(tenantId, '5548999990000', 'oi')
      .catch((e: unknown) => e);
    expect((err as BusinessError).code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect((err as BusinessError).details?.missing).toEqual(['wabaId', 'apiToken']);
  });

  it('token da Meta revogado (apiToken: null): o envio recusa com missing [apiToken]', async () => {
    await saveCloudFields().expect(200);
    await saveCloudFields(admin, { apiToken: null } as unknown as typeof cloudFields).expect(200);
    const err = await build({ ...ENV_FALLBACK, apiUrl: 'https://graph.test' })
      .assertCloudApiConfigured(tenantId)
      .catch((e: unknown) => e);
    expect((err as BusinessError).code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect((err as BusinessError).details?.missing).toEqual(['apiToken']);
  });

  it('driver mock (WHATSAPP_API_URL vazia) envia sem credencial, em qualquer ambiente', async () => {
    const res = await build(ENV_FALLBACK).send(tenantId, '5548999990000', 'oi');
    expect(res.externalId).toBeTruthy();
  });
});
