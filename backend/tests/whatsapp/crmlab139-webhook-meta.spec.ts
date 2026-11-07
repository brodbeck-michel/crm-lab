/**
 * CRMLAB-139 — webhook da Meta (D-311).
 *
 * - `GET /webhooks/whatsapp/:tenant`: verificação da URL (`hub.challenge` em
 *   texto puro com o token certo; 403 sem corpo em qualquer outro caso);
 * - a Meta manda mensagens E status para a MESMA URL: o POST trata os dois;
 * - status nunca regride, casa por `external_message_id` e `tenant_id`;
 * - `value.metadata.phone_number_id` diferente do número do laboratório, ausente,
 *   ou laboratório sem número: descarta (falha fechado — o segredo do HMAC pode
 *   ser o da instalação inteira);
 * - formato plano (sem `entry[]`) só com o driver mock;
 * - reação vira reação (D-222), não fala; `system`/`request_welcome` ignorados;
 *   botão, lista, localização e contato viram texto legível; citação preservada;
 * - fala recebida pela Meta abre a janela de 24 h (`received_via = 'cloud_api'`).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { logger } from '../../src/lib/logger.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
} from '../../src/services/whatsapp.service.js';
import { createConversation, createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import type { WhatsAppCredentials } from '../../src/services/whatsapp.service.js';
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

function post(slug: string, payload: unknown, target: TestApp = app) {
  const body = JSON.stringify(payload);
  return target.agent
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

/** App com as credenciais do laboratório alteradas (ex.: sem número, URL real). */
async function appWith(overrides: Partial<WhatsAppCredentials>): Promise<TestApp> {
  const base = testCredentialsResolver(slugToId);
  const whatsapp = new WhatsAppService({
    credentials: {
      forTenant: async (tenantId) => ({ ...(await base.forTenant(tenantId)), ...overrides }),
      byWebhookIdentity: async (identity) => {
        const found = await base.byWebhookIdentity(identity);
        return found ? { ...found, ...overrides } : null;
      },
    },
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db: await getTestDb(), modules: [makeWebhookModule({ whatsapp })] });
}

async function patientMessages(tenantId: string) {
  return query<{ content: string; quoted_external_id: string | null; received_via: string | null }>(
    `SELECT content, quoted_external_id, received_via FROM messages
      WHERE tenant_id = $1 AND sender_type = 'patient' ORDER BY created_at, external_message_id`,
    [tenantId],
  );
}

/** Uma mensagem da Meta de `type` qualquer, do paciente. */
function typed(type: string, fields: Record<string, unknown>, id = `wamid.${randomUUID()}`) {
  return {
    contacts: [{ wa_id: '5548999991234', profile: { name: 'Joao' } }],
    messages: [{ id, from: '5548999991234', timestamp: '1730880000', type, ...fields }],
  };
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
  vi.restoreAllMocks();
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

  it('hub.challenge fora de [A-Za-z0-9._-]{1,256}, longo demais ou repetido: 403 (nada refletido)', async () => {
    await lab('lab-a');
    const base = { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY };
    for (const challenge of ['<script>alert(1)</script>', 'a b', '9'.repeat(257)]) {
      const response = await verify('lab-a', { ...base, 'hub.challenge': challenge }).expect(403);
      expect(response.text).toBe('');
    }
    await app.agent
      .get(`${WEBHOOK}/lab-a?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1&hub.challenge=2`)
      .expect(403);
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

  it('reentrega BYTE A BYTE da Meta não cai no anti-replay (a mensagem perdida volta) e não duplica', async () => {
    const tenant = await lab('lab-a');
    const notice = metaNotice(textMessage('5548999991234', 'Oi', 'wamid.IN-REENTREGA'));
    await post('lab-a', notice);
    expect(await patientMessages(tenant.id)).toHaveLength(1);
    // Simula o processamento perdido (restart antes do 200): a Meta reenvia o MESMO corpo.
    await exec(`DELETE FROM messages WHERE tenant_id = $1 AND sender_type = 'patient'`, [tenant.id]);
    await post('lab-a', notice);
    expect(await patientMessages(tenant.id)).toHaveLength(1);
    // E uma terceira entrega idêntica não duplica (dedupe por wamid).
    await post('lab-a', notice);
    expect(await patientMessages(tenant.id)).toHaveLength(1);
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

  it('aviso sem metadata.phone_number_id: descartado (falha fechado)', async () => {
    const tenant = await lab('lab-a');
    const notice = metaNotice(textMessage('5548999991234', 'Oi'));
    const value = notice.entry[0]?.changes[0]?.value as Record<string, unknown>;
    delete value.metadata;
    await post('lab-a', notice);
    expect(await patientMessages(tenant.id)).toHaveLength(0);
  });

  it('laboratório SEM número da Meta: aviso com HMAC válido é recusado (D-311 item 6)', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT-SEM-NUMERO');
    const semNumero = await appWith({ phoneNumberId: '' });
    await post(
      'lab-a',
      metaNotice({ ...textMessage('5548999991234', 'Oi'), statuses: [{ id: 'wamid.OUT-SEM-NUMERO', status: 'read' }] }),
      semNumero,
    );
    expect(await patientMessages(tenant.id)).toHaveLength(0);
    expect(await statusOf(id)).toBe('sent');
  });

  it('lote com dois números: só o value do laboratório entra', async () => {
    const tenant = await lab('lab-a');
    const notice = metaNotice(textMessage('5548999991234', 'Do lab'));
    const outro = metaNotice(textMessage('5548999990000', 'De outro'), 'numero-de-OUTRO-lab');
    notice.entry[0]?.changes.push(...(outro.entry[0]?.changes ?? []));
    await post('lab-a', notice);
    expect((await patientMessages(tenant.id)).map((m) => m.content)).toEqual(['Do lab']);
  });

  it('formato plano (sem entry[]) só com o driver mock; com URL real da Meta é recusado', async () => {
    const tenant = await lab('lab-a');
    const flat = { from: '5548999991234', text: 'Plano' };
    const real = await appWith({ apiUrl: 'https://graph.facebook.com/v21.0' });
    await post('lab-a', flat, real);
    expect(await patientMessages(tenant.id)).toHaveLength(0);
    await post('lab-a', flat);
    expect((await patientMessages(tenant.id)).map((m) => m.content)).toEqual(['Plano']);
  });

  it('corpo com entry[] (vazio ou todo descartado) NÃO cai no formato plano, nem com URL real nem no mock', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT-PLANO');
    const real = await appWith({ apiUrl: 'https://graph.facebook.com/v21.0' });
    const outroNumero = metaNotice({}, 'numero-de-OUTRO-lab');
    for (const target of [real, app]) {
      await post('lab-a', { entry: [], from: '5548999991234', text: 'oi' }, target);
      await post('lab-a', { ...outroNumero, from: '5548999991234', text: 'oi' }, target);
      await post('lab-a', { entry: [], id: 'wamid.OUT-PLANO', status: 'read' }, target);
      const body = JSON.stringify({ ...outroNumero, id: 'wamid.OUT-PLANO', status: 'read' });
      await target.agent
        .post(`${WEBHOOK}/lab-a/status`)
        .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
    }
    expect(await patientMessages(tenant.id)).toHaveLength(0);
    expect(await statusOf(id)).toBe('sent');
  });

  it('conversa encerrada: reação, system e status não reabrem; botão do paciente reabre', async () => {
    const tenant = await lab('lab-a');
    const conversation = await createConversation({ tenantId: tenant.id, patientPhone: '5548999991234', status: 'closed' });
    await exec(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, status, external_message_id)
       VALUES ($1, $2, $3, 'agent', 'Encerrado', 'sent', 'wamid.OUT-FIM')`,
      [randomUUID(), tenant.id, conversation.id],
    );
    const statusOfConversation = async () =>
      (await query<{ status: string }>('SELECT status FROM conversations WHERE id = $1', [conversation.id]))[0]?.status;

    await post('lab-a', metaNotice(typed('reaction', { reaction: { message_id: 'wamid.OUT-FIM', emoji: '👍' } })));
    await post('lab-a', metaNotice(typed('system', { system: { body: 'trocou de número' } })));
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT-FIM', status: 'read' }] }));
    expect(await statusOfConversation()).toBe('closed');

    await post('lab-a', metaNotice(typed('button', { button: { text: 'Confirmar' } })));
    expect(await statusOfConversation()).toBe('active');
  });

  it('status pelo POST principal emite message.status_updated no WS', async () => {
    const tenant = await lab('lab-a');
    await sentMessage(tenant.id, 'wamid.OUT-WS');
    app.wsHub.clear();
    await post('lab-a', metaNotice({ statuses: [{ id: 'wamid.OUT-WS', status: 'delivered' }] }));
    expect(app.wsHub.eventsFor(tenant.id, 'message.status_updated')).toHaveLength(1);
  });

  it('logs: failed só com o código; status desconhecido e fora do mapa registrados', async () => {
    const tenant = await lab('lab-a');
    await sentMessage(tenant.id, 'wamid.OUT-LOG');
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    await post(
      'lab-a',
      metaNotice({
        statuses: [
          { id: 'wamid.OUT-LOG', status: 'failed', recipient_id: '5548999991234', errors: [{ code: 131047, title: 'Re-engagement' }] },
          { id: 'wamid.NAO-EXISTE', status: 'read' },
          { id: 'wamid.OUT-LOG', status: 'deleted' },
        ],
      }),
    );
    const all = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(all).toContain('131047');
    expect(all).not.toContain('5548999991234');
    expect(all).not.toContain('Re-engagement');
    const events = [...warn.mock.calls, ...info.mock.calls].map((call) => call[0]);
    expect(events).toContain('whatsapp.status_ignored');
    expect(events).toContain('whatsapp.status_unmapped');
  });

  it('reação do paciente vira reação (D-222), não fala; tirar a reação remove', async () => {
    const tenant = await lab('lab-a');
    const id = await sentMessage(tenant.id, 'wamid.OUT-REACAO');
    await post('lab-a', metaNotice(typed('reaction', { reaction: { message_id: 'wamid.OUT-REACAO', emoji: '👍' } })));
    expect(await patientMessages(tenant.id)).toHaveLength(0);
    const reactions = () =>
      query<{ emoji: string; reactor_type: string }>(
        'SELECT emoji, reactor_type FROM message_reactions WHERE tenant_id = $1 AND message_id = $2',
        [tenant.id, id],
      );
    expect(await reactions()).toEqual([{ emoji: '👍', reactor_type: 'patient' }]);
    await post('lab-a', metaNotice(typed('reaction', { reaction: { message_id: 'wamid.OUT-REACAO' } })));
    expect(await reactions()).toEqual([]);
    expect(await patientMessages(tenant.id)).toHaveLength(0);
  });

  it('system e request_welcome são ignorados; unsupported entra com aviso', async () => {
    const tenant = await lab('lab-a');
    await post('lab-a', metaNotice(typed('system', { system: { body: 'trocou de número' } })));
    await post('lab-a', metaNotice(typed('request_welcome', {})));
    expect(await patientMessages(tenant.id)).toHaveLength(0);
    await post('lab-a', metaNotice(typed('unsupported', { errors: [{ code: 131051 }] })));
    const rows = await patientMessages(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain('tipo de mensagem que o CRM ainda não mostra');
  });

  it('botão de modelo, lista, botão interativo, localização e contato viram texto legível', async () => {
    const tenant = await lab('lab-a');
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['button', { button: { text: 'Confirmar', payload: 'CONFIRMAR' } }, 'Confirmar'],
      ['interactive', { interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Sim' } } }, 'Sim'],
      [
        'interactive',
        { interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Manhã', description: '7h às 11h' } } },
        'Manhã — 7h às 11h',
      ],
      ['location', { location: { latitude: -28.47, longitude: -49.01, name: 'Casa' } }, '📍 Casa (-28.47, -49.01)'],
      [
        'contacts',
        { contacts: [{ name: { formatted_name: 'Maria' }, phones: [{ phone: '+55 48 99999-0000' }] }] },
        '👤 Maria (+55 48 99999-0000)',
      ],
    ];
    for (const [type, fields] of cases) await post('lab-a', metaNotice(typed(type, fields)));
    const contents = (await patientMessages(tenant.id)).map((m) => m.content);
    expect(contents.sort()).toEqual(cases.map(([, , expected]) => expected).sort());
  });

  it('resposta citando: context.id vira quoted_external_id', async () => {
    const tenant = await lab('lab-a');
    await sentMessage(tenant.id, 'wamid.OUT-CITADA');
    await post(
      'lab-a',
      metaNotice(typed('text', { text: { body: 'Sobre isso' }, context: { from: 'x', id: 'wamid.OUT-CITADA' } })),
    );
    expect(await patientMessages(tenant.id)).toEqual([
      { content: 'Sobre isso', quoted_external_id: 'wamid.OUT-CITADA', received_via: 'cloud_api' },
    ]);
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
          {
            id: 'wamid.DOC1',
            from: '5548999991234',
            timestamp: '1730880002',
            type: 'document',
            document: { id: 'D', filename: 'pedido.pdf' },
          },
        ],
      }),
    );
    const rows = await query<{ content: string; message_type: string; attachment_url: string | null; received_via: string }>(
      `SELECT content, message_type, attachment_url, received_via FROM messages
        WHERE tenant_id = $1 AND sender_type = 'patient' ORDER BY external_message_id DESC`,
      [tenant.id],
    );
    expect(rows).toHaveLength(3);
    const contents = rows.map((r) => r.content);
    expect(contents).toContain(
      'Meu pedido médico\n\n[Recebido pela API oficial: imagem — o anexo ainda não aparece no CRM. ' +
        'Se precisar, peça ao paciente que descreva por texto.]',
    );
    expect(contents.some((c) => c.startsWith('[Recebido pela API oficial: áudio —'))).toBe(true);
    expect(contents.some((c) => c.startsWith('[Recebido pela API oficial: documento "pedido.pdf" —'))).toBe(true);
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
