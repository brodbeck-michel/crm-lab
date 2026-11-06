/**
 * CRMLAB-139 — webhook da Meta (D-311).
 *
 * - `GET /webhooks/whatsapp/:tenant`: verificação da URL (`hub.challenge` em
 *   texto puro com o token certo; 403 sem corpo em qualquer outro caso);
 * - a Meta manda mensagens E status para a MESMA URL: o POST trata os dois;
 * - status nunca regride, casa por `external_message_id` e `tenant_id`;
 * - `value.metadata.phone_number_id` diferente do número do laboratório: descarta;
 * - fala recebida pela Meta abre a janela de 24 h (`received_via = 'cloud_api'`).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
} from '../../src/services/whatsapp.service.js';
import { createConversation, createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET, testCredentialsResolver } from './fixtures.js';

const WEBHOOK = '/api/v1/webhooks/whatsapp';
const VERIFY = 'token-de-verificacao';

let app: TestApp;
let slugToId: Map<string, string>;
const originalVerify = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) => tx.query<T & Record<string, unknown>>(sql, params));
  return result.rows as T[];
}

/** Aviso da Meta com mensagens e/ou status no mesmo `value`. */
function metaNotice(value: Record<string, unknown>, phoneNumberId = 'numero-do-lab') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value },
          },
        ],
      },
    ],
  };
}

function textMessage(phone: string, text: string, id = `wamid.${randomUUID()}`) {
  return {
    contacts: [{ wa_id: phone, profile: { name: 'Joao' } }],
    messages: [{ id, from: phone, timestamp: '1730880000', type: 'text', text: { body: text } }],
  };
}

function post(slug: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return app.agent
    .post(`${WEBHOOK}/${slug}`)
    .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
    .set('Content-Type', 'application/json')
    .send(body)
    .expect(200);
}

async function lab(slug: string) {
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  return tenant;
}

/** Mensagem do laboratório já enviada, com id externo, no status dado. */
async function sentMessage(tenantId: string, externalId: string, status = 'sent') {
  const conversation = await createConversation({ tenantId });
  const id = randomUUID();
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, status, external_message_id)
     VALUES ($1, $2, $3, 'agent', 'Olá', $4, $5)`,
    [id, tenantId, conversation.id, status, externalId],
  );
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const rows = await query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [id]);
  return rows[0]?.status;
}

beforeEach(async () => {
  await resetDatabase();
  slugToId = new Map();
  env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY;
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({ db: await getTestDb(), modules: [makeWebhookModule({ whatsapp })] });
});

afterEach(() => {
  env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = originalVerify;
});

describe('GET /webhooks/whatsapp/:tenant — verificação da URL', () => {
  const verify = (slug: string, params: Record<string, string>) =>
    app.agent.get(`${WEBHOOK}/${slug}`).query(params);

  it('token certo: 200 com o hub.challenge em texto puro', async () => {
    await lab('lab-a');
    const response = await verify('lab-a', {
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY,
      'hub.challenge': '1158201444',
    }).expect(200);
    expect(response.text).toBe('1158201444');
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('token errado, modo errado, sem challenge ou laboratório desconhecido: 403 sem corpo', async () => {
    await lab('lab-a');
    const base = { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '42' };
    for (const [slug, params] of [
      ['lab-a', { ...base, 'hub.verify_token': 'errado' }],
      ['lab-a', { ...base, 'hub.mode': 'unsubscribe' }],
      ['lab-a', { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY }],
      ['nao-existe', base],
    ] as const) {
      const response = await verify(slug, params).expect(403);
      expect(response.text).toBe('');
    }
  });

  it('sem WHATSAPP_WEBHOOK_VERIFY_TOKEN configurado: 403 sempre (mesmo com token vazio)', async () => {
    await lab('lab-a');
    env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = undefined;
    await verify('lab-a', { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '42' }).expect(403);
  });

  it('canal desligado (is_active = false): 403', async () => {
    const tenant = await lab('lab-a');
    const whatsapp = new WhatsAppService({
      credentials: {
        forTenant: async () => {
          throw new Error('nao usado');
        },
        byWebhookIdentity: async (identity) => {
          const base = await testCredentialsResolver(slugToId).byWebhookIdentity(identity);
          return base ? { ...base, isActive: false } : null;
        },
      },
      driver: new MockWhatsAppDriver(),
    });
    const disabled = await createTestApp({ db: await getTestDb(), modules: [makeWebhookModule({ whatsapp })] });
    expect(tenant.id).toBeTruthy();
    await disabled.agent
      .get(`${WEBHOOK}/lab-a`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '42' })
      .expect(403);
  });
});

describe('POST /webhooks/whatsapp/:tenant — mensagens e status na mesma URL', () => {
  it('status no POST principal (sem /status): sent -> delivered -> read, e nunca volta', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT1');

    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT1', status: 'delivered' }] }));
    expect(await statusOf(id)).toBe('delivered');
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT1', status: 'read' }] }));
    expect(await statusOf(id)).toBe('read');
    // `delivered` atrasado não apaga o `read`; `failed` depois de lida também não.
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT1', status: 'delivered' }] }));
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT1', status: 'failed' }] }));
    expect(await statusOf(id)).toBe('read');
  });

  it('failed a partir de sent vale; status de mensagem desconhecida é ignorado sem erro', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT2');
    await post(
      'lab-a',
      metaNotice({
        statuses: [
          { id: 'wamid.OUT2', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] },
          { id: 'wamid.NAO_EXISTE', status: 'read' },
        ],
      }),
    );
    expect(await statusOf(id)).toBe('failed');
  });

  it('status casa por tenant: o mesmo id externo em outro laboratório não muda', async () => {
    const a = await lab('lab-a');
    const b = await lab('lab-b');
    const idA = await sentMessage(a.id, 'wamid.MESMO');
    const idB = await sentMessage(b.id, 'wamid.MESMO');
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.MESMO', status: 'read' }] }));
    expect(await statusOf(idA)).toBe('read');
    expect(await statusOf(idB)).toBe('sent');
  });

  it('mensagem e status no MESMO aviso: os dois entram', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT3');
    await post(
      'lab-a',
      metaNotice({ ...textMessage('5548999991234', 'Oi'), statuses: [{ id: 'wamid.OUT3', status: 'delivered' }] }),
    );
    expect(await statusOf(id)).toBe('delivered');
    const patient = await query<{ content: string; received_via: string | null }>(
      `SELECT content, received_via FROM messages WHERE tenant_id = $1 AND sender_type = 'patient'`,
      [tenant.id],
    );
    expect(patient).toEqual([{ content: 'Oi', received_via: 'cloud_api' }]);
  });

  it('reentrega da mesma mensagem (mesmo wamid) não duplica', async () => {
    const tenant = await lab('lab-a');
    const notice = metaNotice(textMessage('5548999991234', 'Oi', 'wamid.IN1'));
    await post('lab-a', notice);
    // Corpo idêntico seria barrado pelo anti-replay; muda só o nome do perfil.
    const again = metaNotice({
      ...textMessage('5548999991234', 'Oi', 'wamid.IN1'),
      contacts: [{ wa_id: '5548999991234', profile: { name: 'Joao S' } }],
    });
    await post('lab-a', again);
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages WHERE tenant_id = $1 AND sender_type = 'patient'`,
      [tenant.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('phone_number_id diferente do laboratório: aviso descartado (nem mensagem nem status)', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT4');
    await post(
      'lab-a',
      metaNotice(
        { ...textMessage('5548999991234', 'Oi'), statuses: [{ id: 'wamid.OUT4', status: 'read' }] },
        'numero-de-OUTRO-lab',
      ),
    );
    expect(await statusOf(id)).toBe('sent');
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages WHERE tenant_id = $1 AND sender_type = 'patient'`,
      [tenant.id],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('mídia recebida (até o CRMLAB-140): vira texto com aviso e legenda, marcada como cloud_api', async () => {
    const tenant = await lab('lab-a');
    await post(
      'lab-a',
      metaNotice({
        contacts: [{ wa_id: '5548999991234', profile: { name: 'Joao' } }],
        messages: [
          {
            id: 'wamid.IMG1',
            from: '5548999991234',
            timestamp: '1730880000',
            type: 'image',
            image: { id: 'MEDIA_ID', mime_type: 'image/jpeg', caption: 'Meu pedido médico' },
          },
          { id: 'wamid.AUD1', from: '5548999991234', timestamp: '1730880001', type: 'audio', audio: { id: 'A' } },
        ],
      }),
    );
    const rows = await query<{ content: string; message_type: string; attachment_url: string | null; received_via: string }>(
      `SELECT content, message_type, attachment_url, received_via FROM messages
        WHERE tenant_id = $1 AND sender_type = 'patient' ORDER BY external_message_id DESC`,
      [tenant.id],
    );
    expect(rows).toHaveLength(2);
    const [image, audio] = [rows.find((r) => r.content.startsWith('Meu pedido')), rows.find((r) => r.content.startsWith('[Áudio'))];
    expect(image?.content).toContain('[Imagem recebida pela API oficial');
    expect(audio).toBeDefined();
    for (const row of rows) {
      expect(row).toMatchObject({ message_type: 'text', attachment_url: null, received_via: 'cloud_api' });
    }
  });

  it('a rota /status antiga continua aceitando status (compatibilidade)', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT5');
    const body = JSON.stringify(metaNotice({ statuses: [{ id: 'wamid.OUT5', status: 'delivered' }] }));
    await app.agent
      .post(`${WEBHOOK}/lab-a/status`)
      .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
    expect(await statusOf(id)).toBe('delivered');
  });
});
