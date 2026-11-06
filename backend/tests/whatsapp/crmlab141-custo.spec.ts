/**
 * CRMLAB-141 — custo estimado da Cloud API (D-312).
 *
 * - envio confirmado pela Cloud API grava `pricing_category`: `service` (texto
 *   na janela) ou a categoria do modelo; `qr` fica NULL;
 * - `pricing.category` do status da Meta vence a estimativa; fora das quatro, ignorado;
 * - `GET /settings/channels/whatsapp/usage`: franquia de `service` por mês civil
 *   (America/Sao_Paulo), preço vigente na data de cada mensagem, só `sent`+,
 *   só o que o CRM enviou, por laboratório; gestor e admin.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { channelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET } from './fixtures.js';

const USAGE = '/api/v1/settings/channels/whatsapp/usage';
const originalAllowance = env.WHATSAPP_FREE_SERVICE_MONTHLY;

let app: TestApp;
let driver: MockWhatsAppDriver;
let modes: Map<string, 'qr' | 'cloud_api'>;
let slugToId: Map<string, string>;

function resolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => {
    const mode = modes.get(tenantId) ?? 'cloud_api';
    return {
      tenantId,
      phoneNumberId: 'numero-do-lab',
      apiUrl: '',
      wabaId: '',
      apiToken: '',
      webhookSecret: TEST_WEBHOOK_SECRET,
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: mode,
      qrInstanceApiKey: mode === 'qr' ? 'apikey' : null,
    };
  };
  return {
    forTenant: async (id) => build(id),
    byWebhookIdentity: async (identity) => {
      const id = slugToId.get(identity);
      return id ? build(id) : null;
    },
  };
}

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) => tx.query<T & Record<string, unknown>>(sql, params));
  return result.rows as T[];
}

async function lab(mode: 'qr' | 'cloud_api' = 'cloud_api') {
  const slug = `lab-${randomUUID().slice(0, 8)}`;
  const tenant = await createTenant({ slug });
  slugToId.set(slug, tenant.id);
  modes.set(tenant.id, mode);
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  const gestor = await createUser({ tenantId: tenant.id, role: 'manager', name: 'Gil' });
  await exec(
    `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode) VALUES ($1, 'whatsapp', TRUE, $2)`,
    [tenant.id, mode],
  );
  await exec(`UPDATE tenant_channels SET cloud_api_since = NOW() - interval '30 days' WHERE tenant_id = $1`, [
    tenant.id,
  ]);
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  // Paciente escreveu pela Meta: janela aberta para texto livre.
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, received_via, external_message_id)
     VALUES ($1, $2, $3, 'patient', 'oi', 'cloud_api', $4)`,
    [randomUUID(), tenant.id, conversation.id, `wamid.${randomUUID()}`],
  );
  return { tenant, slug, ana, gestor, conversation };
}

async function pricingOf(conversationId: string): Promise<Array<string | null>> {
  const rows = await query<{ pricing_category: string | null }>(
    `SELECT pricing_category FROM messages WHERE conversation_id = $1 AND sender_type = 'agent' ORDER BY created_at`,
    [conversationId],
  );
  return rows.map((r) => r.pricing_category);
}

/** Mensagem do CRM já enviada, com data, status e categoria escolhidos. */
async function sent(
  tenantId: string,
  conversationId: string,
  options: { at: string; category: string | null; status?: string; sender?: string },
): Promise<void> {
  await exec(
    `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, status, created_at, pricing_category,
                           external_message_id)
     VALUES ($1, $2, $3, $4, 'x', $5, $6::timestamp, $7, $8)`,
    [
      randomUUID(),
      tenantId,
      conversationId,
      options.sender ?? 'agent',
      options.status ?? 'delivered',
      options.at,
      options.category,
      `wamid.${randomUUID()}`,
    ],
  );
}

function usage(user: { id: string }, month?: string) {
  const request = app.agent.get(USAGE).set(app.auth(user as Parameters<TestApp['auth']>[0]));
  return month === undefined ? request : request.query({ month });
}

beforeEach(async () => {
  await resetDatabase();
  modes = new Map();
  slugToId = new Map();
  driver = new MockWhatsAppDriver();
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver,
    evolutionDriver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
  });
  app = await createTestApp({
    db: await getTestDb(),
    modules: [makeConversationModule({ whatsapp }), makeWebhookModule({ whatsapp }), channelSettingsModule],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.WHATSAPP_FREE_SERVICE_MONTHLY = originalAllowance;
  // A tabela de preços é de referência (o reset não a zera): só o seed fica.
  await exec(`DELETE FROM whatsapp_price_table WHERE effective_from <> '2026-10-01'`, []);
});

describe('categoria de cobrança no envio (D-312 item 1)', () => {
  it('cloud_api: texto na janela = service; modelo = categoria do modelo', async () => {
    const { ana, conversation } = await lab();
    const post = (body: Record<string, unknown>) =>
      app.agent.post(`/api/v1/conversations/${conversation.id}/messages`).set(app.auth(ana)).send(body).expect(201);
    await post({ content: 'Bom dia' });
    await post({ template: { name: 'lembrete_coleta', language: 'pt_BR', variables: ['Maria', '12/11'] } });
    expect(await pricingOf(conversation.id)).toEqual(['service', 'utility']);
  });

  it('qr: categoria fica NULL', async () => {
    const { ana, conversation } = await lab('qr');
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Bom dia' })
      .expect(201);
    expect(await pricingOf(conversation.id)).toEqual([null]);
  });

  it('envio que falhou não ganha categoria', async () => {
    const { ana, conversation } = await lab();
    vi.spyOn(driver, 'send').mockRejectedValueOnce(new Error('gateway fora'));
    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .set(app.auth(ana))
      .send({ content: 'Bom dia' });
    expect(await pricingOf(conversation.id)).toEqual([null]);
  });
});

describe('pricing.category do status da Meta', () => {
  async function postStatus(slug: string, statuses: unknown[]) {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'numero-do-lab' }, statuses } }] }],
    });
    await app.agent
      .post(`/api/v1/webhooks/whatsapp/${slug}`)
      .set('x-hub-signature-256', signWebhookBody(body, TEST_WEBHOOK_SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  }

  it('vence a estimativa (mesmo com status repetido); categoria desconhecida é ignorada', async () => {
    const { tenant, slug, conversation } = await lab();
    await exec(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, status, external_message_id, pricing_category)
       VALUES ($1, $2, $3, 'agent', 'oi', 'delivered', 'wamid.P1', 'service')`,
      [randomUUID(), tenant.id, conversation.id],
    );
    await postStatus(slug, [{ id: 'wamid.P1', status: 'delivered', pricing: { category: 'marketing', billable: true } }]);
    expect(await pricingOf(conversation.id)).toEqual(['marketing']);
    await postStatus(slug, [{ id: 'wamid.P1', status: 'read', pricing: { category: 'referral_conversion' } }]);
    expect(await pricingOf(conversation.id)).toEqual(['marketing']);
  });

  it('não toca mensagem de outro laboratório nem fala do paciente com o mesmo id', async () => {
    const a = await lab();
    const b = await lab();
    await exec(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, status, external_message_id, pricing_category)
       VALUES ($1, $2, $3, 'agent', 'oi', 'sent', 'wamid.MESMO', 'service')`,
      [randomUUID(), b.tenant.id, b.conversation.id],
    );
    await postStatus(a.slug, [{ id: 'wamid.MESMO', status: 'delivered', pricing: { category: 'marketing' } }]);
    expect(await pricingOf(b.conversation.id)).toEqual(['service']);
  });
});

describe('GET /settings/channels/whatsapp/usage', () => {
  it('franquia de service por ordem, preço por data, só sent+, só o CRM, virada de mês no fuso de SP', async () => {
    env.WHATSAPP_FREE_SERVICE_MONTHLY = 2;
    const { tenant, gestor, conversation } = await lab();
    // Marketing muda de preço no meio de outubro.
    await exec(`INSERT INTO whatsapp_price_table (category, price_brl, effective_from) VALUES ('marketing', 0.5000, '2026-10-15')`, []);

    // 3 service em outubro: as 2 primeiras grátis.
    await sent(tenant.id, conversation.id, { at: '2026-10-02 12:00:00', category: 'service' });
    await sent(tenant.id, conversation.id, { at: '2026-10-03 12:00:00', category: 'service' });
    // 01/11 02:00 UTC = 31/10 23:00 em São Paulo: ainda é outubro.
    await sent(tenant.id, conversation.id, { at: '2026-11-01 02:00:00', category: 'service' });
    // Marketing antes e depois do reajuste.
    await sent(tenant.id, conversation.id, { at: '2026-10-10 12:00:00', category: 'marketing' });
    await sent(tenant.id, conversation.id, { at: '2026-10-20 12:00:00', category: 'marketing', status: 'read' });
    await sent(tenant.id, conversation.id, { at: '2026-10-21 12:00:00', category: 'utility', status: 'sent' });
    // Não contam: falhou, pendente, de novembro (local), sem categoria (qr).
    await sent(tenant.id, conversation.id, { at: '2026-10-22 12:00:00', category: 'utility', status: 'failed' });
    await sent(tenant.id, conversation.id, { at: '2026-10-22 13:00:00', category: 'utility', status: 'pending' });
    await sent(tenant.id, conversation.id, { at: '2026-11-01 04:00:00', category: 'service' });
    await sent(tenant.id, conversation.id, { at: '2026-10-23 12:00:00', category: null });

    const response = await usage(gestor, '2026-10').expect(200);
    expect(response.body).toEqual({
      month: '2026-10',
      currency: 'BRL',
      freeServiceAllowance: 2,
      categories: [
        { category: 'service', count: 3, freeCount: 2, unitPrice: 0.035, cost: 0.04 },
        { category: 'utility', count: 1, freeCount: 0, unitPrice: 0.035, cost: 0.04 },
        { category: 'marketing', count: 2, freeCount: 0, unitPrice: 0.5, cost: 0.82 },
        { category: 'authentication', count: 0, freeCount: 0, unitPrice: 0.035, cost: 0 },
      ],
      totalCost: 0.9,
      isEstimate: true,
    });
  });

  it('isolamento: o relatório de um laboratório não conta mensagem do outro', async () => {
    const a = await lab();
    const b = await lab();
    await sent(b.tenant.id, b.conversation.id, { at: '2026-10-05 12:00:00', category: 'marketing' });
    const response = await usage(a.gestor, '2026-10').expect(200);
    expect(response.body.totalCost).toBe(0);
    expect(response.body.categories.every((c: { count: number }) => c.count === 0)).toBe(true);
  });

  it('sem month: mês corrente; admin também lê', async () => {
    const { tenant } = await lab();
    const admin = await createUser({ tenantId: tenant.id, role: 'admin', name: 'Adm' });
    const response = await usage(admin).expect(200);
    expect(response.body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(response.body.freeServiceAllowance).toBe(originalAllowance);
  });

  it('month inválido, repetido ou futuro: 400; atendente: 403', async () => {
    const { ana, gestor } = await lab();
    for (const month of ['2026-13', '2026-1', 'outubro', '2999-01']) {
      const response = await usage(gestor, month).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    await app.agent
      .get(`${USAGE}?month=2026-10&month=2026-09`)
      .set(app.auth(gestor))
      .expect(400);
    const forbidden = await usage(ana, '2026-10').expect(403);
    expect(forbidden.body.error.details.requiredRoles).toEqual(['manager', 'admin']);
  });
});

describe('whatsapp_price_table (migração 065)', () => {
  it('seed oficial de 01/10/2026 e crm_app só lê', async () => {
    const rows = await query<{ category: string; price_brl: string }>(
      `SELECT category, price_brl::text AS price_brl FROM whatsapp_price_table WHERE effective_from = '2026-10-01' ORDER BY category`,
      [],
    );
    expect(rows).toEqual([
      { category: 'authentication', price_brl: '0.0350' },
      { category: 'marketing', price_brl: '0.3217' },
      { category: 'service', price_brl: '0.0350' },
      { category: 'utility', price_brl: '0.0350' },
    ]);
    const privileges = await query<{ can_select: boolean; can_insert: boolean; can_update: boolean }>(
      `SELECT has_table_privilege('crm_app', 'whatsapp_price_table', 'SELECT') AS can_select,
              has_table_privilege('crm_app', 'whatsapp_price_table', 'INSERT') AS can_insert,
              has_table_privilege('crm_app', 'whatsapp_price_table', 'UPDATE') AS can_update`,
      [],
    );
    expect(privileges[0]).toEqual({ can_select: true, can_insert: false, can_update: false });
  });
});
