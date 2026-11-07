/**
 * CRMLAB-136 — modelos aprovados da Meta (D-309).
 *
 * Lista (`GET /whatsapp/templates`): só APPROVED + MARKETING|UTILITY, só corpo
 * de texto com `{{n}}` posicionais; cache de 5 min por laboratório que se
 * invalida sozinho ao trocar credencial ou modo. Envio: `template` exclusivo
 * de `content`, conferido contra a lista, vale dentro e fora da janela de 24 h.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeConversationModule } from '../../src/controllers/conversation.routes.js';
import { makeWhatsAppTemplateModule } from '../../src/controllers/whatsapp-template.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  fillTemplate,
  parseMetaTemplate,
  parseMetaTemplates,
  placeholderCount,
} from '../../src/services/whatsapp-templates.js';
import {
  MockWhatsAppDriver,
  TEMPLATE_CACHE_TTL_MS,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { TEST_WEBHOOK_SECRET } from '../whatsapp/fixtures.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let driver: MockWhatsAppDriver;
let app: TestApp;
let clock: number;
/** Credenciais por laboratório; o teste muda para simular troca de modo/credencial. */
let overrides: Map<string, Partial<WhatsAppCredentials>>;

function resolver(): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    wabaId: '',
    apiToken: '',
    webhookSecret: TEST_WEBHOOK_SECRET,
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
    ...overrides.get(tenantId),
  });
  return { forTenant: async (id) => build(id), byWebhookIdentity: async () => null };
}

async function exec(sql: string, params: unknown[]): Promise<void> {
  const db = await getTestDb();
  await db.withoutTenant((tx) => tx.query(sql, params));
}

async function lab(mode: 'qr' | 'cloud_api' = 'cloud_api') {
  const tenant = await createTenant();
  const ana = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Ana' });
  await exec(
    `INSERT INTO tenant_channels (tenant_id, channel, is_active, connection_mode) VALUES ($1, 'whatsapp', TRUE, $2)`,
    [tenant.id, mode],
  );
  await exec(
    `UPDATE tenant_channels SET cloud_api_since = NOW() - interval '30 days' WHERE tenant_id = $1`,
    [tenant.id],
  );
  if (mode === 'qr') overrides.set(tenant.id, { connectionMode: 'qr', qrInstanceApiKey: 'apikey' });
  const conversation = await createConversation({ tenantId: tenant.id, assignedTo: ana.id });
  return { tenant, ana, conversation };
}

async function messagesOf(conversationId: string) {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<{
      content: string;
      status: string;
      template_name: string | null;
      template_language: string | null;
      template_category: string | null;
      template_variables: unknown;
    }>(
      `SELECT content, status, template_name, template_language, template_category, template_variables
         FROM messages WHERE conversation_id = $1 AND sender_type = 'agent' ORDER BY created_at`,
      [conversationId],
    ),
  );
  return result.rows;
}

function sendTemplate(conversationId: string, user: { id: string }, body: Record<string, unknown>) {
  return app.agent
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(app.auth(user as Parameters<TestApp['auth']>[0]))
    .send(body);
}

const LEMBRETE = { name: 'lembrete_coleta', language: 'pt_BR', variables: ['Maria', '12/11 às 8h'] };

beforeEach(async () => {
  await resetDatabase();
  const db = await getTestDb();
  clock = 1_000_000;
  overrides = new Map();
  driver = new MockWhatsAppDriver();
  const whatsapp = new WhatsAppService({
    credentials: resolver(),
    driver,
    queue: createInMemoryQueue({ sleep: async () => undefined }),
    attempts: 1,
    now: () => clock,
  });
  app = await createTestApp({
    db,
    modules: [makeConversationModule({ whatsapp }), makeWhatsAppTemplateModule({ whatsapp })],
  });
});

describe('leitura dos modelos da Meta (funções puras)', () => {
  const body = (text: string, extra: Record<string, unknown> = {}) => ({
    name: 'm',
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text }],
    ...extra,
  });

  it('aceita só APPROVED, MARKETING|UTILITY e corpo de texto puro', () => {
    expect(parseMetaTemplate(body('Oi'))).not.toBeNull();
    expect(parseMetaTemplate(body('Oi', { category: 'MARKETING' }))?.category).toBe('marketing');
    expect(parseMetaTemplate(body('Oi', { status: 'PENDING' }))).toBeNull();
    expect(parseMetaTemplate(body('Oi', { category: 'AUTHENTICATION' }))).toBeNull();
    expect(
      parseMetaTemplate(
        body('Oi', { components: [{ type: 'HEADER', format: 'TEXT', text: 'T' }, { type: 'BODY', text: 'Oi' }] }),
      ),
    ).toBeNull();
    expect(
      parseMetaTemplate(body('Oi', { components: [{ type: 'BODY', text: 'Oi' }, { type: 'BUTTONS', buttons: [] }] })),
    ).toBeNull();
    expect(parseMetaTemplate(body('Oi {{nome}}', { parameter_format: 'NAMED' }))).toBeNull();
    expect(parseMetaTemplate(null)).toBeNull();
  });

  it('variáveis posicionais 1..n sem buraco; exemplo da Meta quando há', () => {
    expect(placeholderCount('Oi {{1}}, {{2}} e {{1}} de novo')).toBe(2);
    expect(placeholderCount('Oi {{2}}')).toBeNull();
    expect(placeholderCount('Oi {{nome}}')).toBeNull();
    expect(placeholderCount('Sem variável')).toBe(0);
    const parsed = parseMetaTemplate({
      ...body('Oi {{1}}, coleta {{2}}'),
      components: [{ type: 'BODY', text: 'Oi {{1}}, coleta {{2}}', example: { body_text: [['Maria']] } }],
    });
    expect(parsed?.variables).toEqual([
      { index: 1, example: 'Maria' },
      { index: 2, example: null },
    ]);
  });

  it('ordem name ASC, language ASC e preenchimento do corpo', () => {
    const list = parseMetaTemplates([
      body('b', { name: 'zeta' }),
      body('a', { name: 'alfa', language: 'pt_BR' }),
      body('a', { name: 'alfa', language: 'en_US' }),
    ]);
    expect(list.map((t) => `${t.name}:${t.language}`)).toEqual(['alfa:en_US', 'alfa:pt_BR', 'zeta:pt_BR']);
    expect(fillTemplate('Oi {{1}}, {{2}} e {{1}}', ['Ana', 'amanhã'])).toBe('Oi Ana, amanhã e Ana');
  });
});

describe('GET /whatsapp/templates', () => {
  it('cloud_api: lista filtrada e ordenada', async () => {
    const { ana } = await lab();
    driver.templates.push({ name: 'codigo', language: 'pt_BR', status: 'APPROVED', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: '{{1}}' }] });
    const response = await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(200);
    expect(response.body.templates.map((t: { name: string }) => t.name)).toEqual([
      'lembrete_coleta',
      'retomar_atendimento',
    ]);
    expect(response.body.templates[0]).toMatchObject({
      language: 'pt_BR',
      category: 'utility',
      variables: [
        { index: 1, example: 'Maria' },
        { index: 2, example: '12/11 às 8h' },
      ],
    });
  });

  it('qr: lista vazia, sem ir à Meta', async () => {
    const { ana } = await lab('qr');
    const response = await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(200);
    expect(response.body).toEqual({ templates: [] });
    expect(driver.templateListCalls).toBe(0);
  });

  it('Meta fora do ar: 503 CHANNEL_CLOUD_API_UNAVAILABLE', async () => {
    const { ana } = await lab();
    driver.failTemplateList = true;
    const response = await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(503);
    expect(response.body.error.code).toBe('CHANNEL_CLOUD_API_UNAVAILABLE');
  });

  it('credencial incompleta (com URL da Meta): 409 com os nomes que faltam', async () => {
    const { tenant, ana } = await lab();
    overrides.set(tenant.id, { apiUrl: 'https://graph.test', wabaId: '', apiToken: '' });
    const response = await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(409);
    expect(response.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
    expect(response.body.error.details.missing).toEqual(['wabaId', 'apiToken']);
  });

  it('cache de 5 min por laboratório; vence pelo tempo e pela troca de credencial', async () => {
    const { tenant, ana } = await lab();
    const get = () => app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(200);
    await get();
    await get();
    expect(driver.templateListCalls).toBe(1);

    clock += TEMPLATE_CACHE_TTL_MS + 1;
    await get();
    expect(driver.templateListCalls).toBe(2);

    overrides.set(tenant.id, { wabaId: 'outra-waba' });
    await get();
    expect(driver.templateListCalls).toBe(3);
  });

  it('cache é por laboratório: a lista de um não serve ao outro', async () => {
    const a = await lab();
    const b = await lab();
    await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(a.ana)).expect(200);
    await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(b.ana)).expect(200);
    expect(driver.templateListCalls).toBe(2);
  });
});

describe('POST /conversations/:id/messages com template', () => {
  it('janela fechada (paciente nunca escreveu): modelo sai, texto preenchido e modelo gravados', async () => {
    const { ana, conversation } = await lab();

    const response = await sendTemplate(conversation.id, ana, { template: LEMBRETE }).expect(201);
    expect(response.body.content).toBe(
      'Olá Maria, sua coleta está agendada para 12/11 às 8h. Qualquer dúvida, responda esta mensagem.',
    );
    expect(response.body.template).toEqual({ name: 'lembrete_coleta', language: 'pt_BR', category: 'utility' });
    expect(response.body.status).toBe('sent');
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.template).toEqual(LEMBRETE);

    const [row] = await messagesOf(conversation.id);
    expect(row).toMatchObject({
      template_name: 'lembrete_coleta',
      template_language: 'pt_BR',
      template_category: 'utility',
      template_variables: ['Maria', '12/11 às 8h'],
    });
  });

  it('texto livre continua com template null', async () => {
    const { tenant, ana, conversation } = await lab();
    await exec(
      `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, received_via, external_message_id)
       VALUES ($1, $2, $3, 'patient', 'oi', 'cloud_api', $4)`,
      [randomUUID(), tenant.id, conversation.id, `wamid.${randomUUID()}`],
    );
    const response = await sendTemplate(conversation.id, ana, { content: 'Bom dia' }).expect(201);
    expect(response.body.template).toBeNull();
  });

  it('modelo fora da lista aprovada: 404 whatsapp_template, nada gravado', async () => {
    const { ana, conversation } = await lab();
    const response = await sendTemplate(conversation.id, ana, {
      template: { name: 'nao_existe', language: 'pt_BR', variables: [] },
    }).expect(404);
    expect(response.body.error.details.resource).toBe('whatsapp_template');
    expect(await messagesOf(conversation.id)).toHaveLength(0);
    expect(driver.sent).toHaveLength(0);
  });

  it('idioma diferente do aprovado também é 404', async () => {
    const { ana, conversation } = await lab();
    await sendTemplate(conversation.id, ana, { template: { ...LEMBRETE, language: 'en_US' } }).expect(404);
  });

  it('variáveis a menos ou em branco: 400 em template.variables', async () => {
    const { ana, conversation } = await lab();
    const poucas = await sendTemplate(conversation.id, ana, {
      template: { ...LEMBRETE, variables: ['Maria'] },
    }).expect(400);
    expect(poucas.body.error.details.fields).toHaveProperty(['template.variables']);
    for (const variables of [['Maria', '   '], ['Maria\nSilva', 'x'], ['Maria\tSilva', 'x'], ['a     b', 'x'], ['x'.repeat(1025), 'y']]) {
      const bad = await sendTemplate(conversation.id, ana, { template: { ...LEMBRETE, variables } }).expect(400);
      expect(bad.body.error.details.fields).toHaveProperty(['template.variables']);
    }
    expect(await messagesOf(conversation.id)).toHaveLength(0);
  });

  it('corpo preenchido acima de 1024 caracteres: 400 em template.variables', async () => {
    const { ana, conversation } = await lab();
    const longo = await sendTemplate(conversation.id, ana, {
      template: { ...LEMBRETE, variables: ['x'.repeat(1000), 'y'.repeat(100)] },
    }).expect(400);
    expect(longo.body.error.details.fields).toHaveProperty(['template.variables']);
    expect(driver.sent).toHaveLength(0);
  });

  it('Meta fora do ar ao conferir o modelo: 503 meta_unreachable, nada gravado', async () => {
    const { ana, conversation } = await lab();
    driver.failTemplateList = true;
    const response = await sendTemplate(conversation.id, ana, { template: LEMBRETE }).expect(503);
    expect(response.body.error.code).toBe('CHANNEL_CLOUD_API_UNAVAILABLE');
    expect(response.body.error.details).toMatchObject({ reason: 'meta_unreachable' });
    expect(await messagesOf(conversation.id)).toHaveLength(0);
  });

  it('participante envia modelo: sem *Nome*, e o tempo de resposta continua da dona (attributed_to)', async () => {
    const { tenant, ana, conversation } = await lab();
    const bruno = await createUser({ tenantId: tenant.id, role: 'attendant', name: 'Bruno' });
    await exec(
      `INSERT INTO conversation_participants (tenant_id, conversation_id, user_id) VALUES ($1, $2, $3)`,
      [tenant.id, conversation.id, bruno.id],
    );
    await sendTemplate(conversation.id, bruno, { template: LEMBRETE }).expect(201);
    expect(driver.sent[0]?.template).toEqual(LEMBRETE);
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ attributed_to: string | null; content: string }>(
        `SELECT attributed_to, content FROM messages WHERE conversation_id = $1 AND sender_type = 'agent'`,
        [conversation.id],
      ),
    );
    expect(row.rows[0]?.attributed_to).toBe(ana.id);
    expect(row.rows[0]?.content.startsWith('*Bruno*')).toBe(false);
  });

  it('"tentar de novo" de modelo depois de o canal voltar para qr: 400 e a mensagem continua failed', async () => {
    const { tenant, ana, conversation } = await lab();
    driver.sendTemplate = async () => {
      throw new Error('Meta recusou');
    };
    const first = await sendTemplate(conversation.id, ana, { template: LEMBRETE }).expect(502);
    const messageId = first.body.error.details.messageId as string;
    overrides.set(tenant.id, { connectionMode: 'qr', qrInstanceApiKey: 'apikey' });

    const retry = await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(400);
    expect(retry.body.error.details.fields).toHaveProperty('template');
    const [row] = await messagesOf(conversation.id);
    expect(row?.status).toBe('failed');
  });

  it('a lista que a tela vê é a mesma que o envio confere (cache compartilhado entre instâncias)', async () => {
    const { ana, conversation } = await lab();
    // A tela carrega a lista (cache cheio)...
    await app.agent.get('/api/v1/whatsapp/templates').set(app.auth(ana)).expect(200);
    const calls = driver.templateListCalls;
    // ...e o envio, por outra instância de serviço, não vai à Meta de novo.
    const other = new WhatsAppService({
      credentials: resolver(),
      driver,
      queue: createInMemoryQueue({ sleep: async () => undefined }),
      attempts: 1,
      now: () => clock,
    });
    await other.listTemplates(conversation.tenantId);
    expect(driver.templateListCalls).toBe(calls);
  });

  it('laboratório em qr: 400 em template', async () => {
    const { ana, conversation } = await lab('qr');
    const response = await sendTemplate(conversation.id, ana, { template: LEMBRETE }).expect(400);
    expect(response.body.error.details.fields).toHaveProperty('template');
  });

  it('content e template juntos, nenhum dos dois, ou modelo com citação: 400', async () => {
    const { ana, conversation } = await lab();
    await sendTemplate(conversation.id, ana, { content: 'Oi', template: LEMBRETE }).expect(400);
    await sendTemplate(conversation.id, ana, {}).expect(400);
    await sendTemplate(conversation.id, ana, { template: LEMBRETE, quotedMessageId: randomUUID() }).expect(400);
  });

  it('credencial incompleta vem antes da validação do modelo (ordem do contrato)', async () => {
    const { tenant, ana, conversation } = await lab();
    overrides.set(tenant.id, { apiUrl: 'https://graph.test', wabaId: '', apiToken: '' });
    const response = await sendTemplate(conversation.id, ana, {
      template: { name: 'nao_existe', language: 'pt_BR', variables: [] },
    }).expect(409);
    expect(response.body.error.code).toBe('CHANNEL_CLOUD_API_NOT_CONFIGURED');
  });

  it('conversa encerrada + modelo inexistente: 404 e a conversa NÃO reabre (D-273)', async () => {
    const { ana, conversation } = await lab();
    await exec(`UPDATE conversations SET status = 'closed' WHERE id = $1`, [conversation.id]);
    await sendTemplate(conversation.id, ana, {
      template: { name: 'nao_existe', language: 'pt_BR', variables: [] },
    }).expect(404);
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string }>('SELECT status FROM conversations WHERE id = $1', [conversation.id]),
    );
    expect(row.rows[0]?.status).toBe('closed');
  });

  it('"tentar de novo" de modelo que falhou reenvia o MESMO modelo, mesmo com a janela fechada', async () => {
    const { ana, conversation } = await lab();
    const failing = driver.sendTemplate.bind(driver);
    driver.sendTemplate = async () => {
      throw new Error('Meta recusou');
    };
    const first = await sendTemplate(conversation.id, ana, { template: LEMBRETE }).expect(502);
    const messageId = first.body.error.details.messageId as string;
    driver.sendTemplate = failing;

    await app.agent
      .post(`/api/v1/conversations/${conversation.id}/messages/${messageId}/retry`)
      .set(app.auth(ana))
      .expect(200);
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.template).toEqual(LEMBRETE);
    const [row] = await messagesOf(conversation.id);
    expect(row?.status).toBe('sent');
  });
});

describe('Nova conversa por modelo (POST /conversations/whatsapp)', () => {
  const URL = '/api/v1/conversations/whatsapp';

  it('número novo em cloud_api: sai pelo modelo, sem 409 de janela', async () => {
    const { ana } = await lab();
    const response = await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-7777', template: LEMBRETE })
      .expect(201);
    expect(response.body.message.template).toMatchObject({ name: 'lembrete_coleta' });
    expect(driver.sent).toHaveLength(1);
  });

  it('modelo inválido: 404 e NENHUMA conversa criada para o número novo', async () => {
    const { tenant, ana } = await lab();
    await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-7777', template: { name: 'nao_existe', language: 'pt_BR', variables: [] } })
      .expect(404);
    const db = await getTestDb();
    const count = await db.withoutTenant((tx) =>
      tx.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM conversations WHERE tenant_id = $1 AND patient_phone = '+5548999997777'`,
        [tenant.id],
      ),
    );
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  it('conversa encerrada de outro canal + modelo inválido: 404 e nada muda (não reabre nem troca o canal)', async () => {
    const { tenant, ana } = await lab();
    const antiga = await createConversation({
      tenantId: tenant.id,
      assignedTo: ana.id,
      status: 'closed',
      channel: 'direct',
      patientPhone: '+5548999997777',
    });
    await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-7777', template: { name: 'nao_existe', language: 'pt_BR', variables: [] } })
      .expect(404);
    const db = await getTestDb();
    const row = await db.withoutTenant((tx) =>
      tx.query<{ status: string; channel: string }>('SELECT status, channel FROM conversations WHERE id = $1', [
        antiga.id,
      ]),
    );
    expect(row.rows[0]).toEqual({ status: 'closed', channel: 'direct' });
  });

  it('content e template juntos: 400', async () => {
    const { ana } = await lab();
    await app.agent
      .post(URL)
      .set(app.auth(ana))
      .send({ phone: '(48) 99999-7777', content: 'Oi', template: LEMBRETE })
      .expect(400);
  });
});
