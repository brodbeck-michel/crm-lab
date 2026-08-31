/**
 * Seguranca do canal por laboratorio — D-074, D-073 (emendada) e D-076.
 *
 * O que estas specs provam, e por que cada uma existe:
 *
 *  - KILL SWITCH DE VERDADE (D-074). `isActive: false` e o unico jeito que o
 *    contrato oferece para desligar um canal (API_CONTRACTS.md §6: "nao existe
 *    remocao nesta rota"). Antes, ele so mudava um chip na tela: o webhook com
 *    HMAC valido continuava criando paciente + conversa + mensagem e o envio
 *    continuava saindo pelo token guardado. A prova aqui e no BANCO, e nos dois
 *    sentidos (entrada e saida).
 *
 *  - REVOGAR REVOGA (D-073 emendada). `{"webhookSecret": null}` apagava a
 *    coluna e o resolver caia em `WHATSAPP_WEBHOOK_SECRET` — um valor unico
 *    para a INSTALACAO INTEIRA. Quem o conhecesse assinava webhook valido para
 *    qualquer laboratorio que ainda nao tivesse girado o proprio, e o slug vai
 *    na URL publica: escrita cross-tenant. O teste assina com o segredo da env
 *    DEPOIS de revogar e exige que nada entre.
 *
 *  - "NUNCA CONFIGUROU" CONTINUA CAINDO NA ENV VAR. A distincao e o ponto: o
 *    fallback de D-073 nao pode morrer junto, senao dev/CI quebram.
 *
 *  - CIFRA EM REPOUSO (D-076). Com `CHANNEL_SECRET_KEY` configurada, a coluna
 *    NAO contem o token em claro — e a tela continua mostrando a mascara certa
 *    (os 4 ultimos caracteres do valor REAL, nao do ciphertext).
 *
 * Todos os cenarios entram pela rota real (`PATCH /settings/channels` como
 * admin), nunca por INSERT de teste: o caminho que o validador descreveu e o do
 * admin que tenta se defender de um vazamento.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelSettingsModule } from '../../src/controllers/channel-settings.routes.js';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  createTenantCredentialsResolver,
  signWebhookBody,
  type WhatsAppCredentials,
} from '../../src/services/whatsapp.service.js';
import { countConversations, countMessages } from '../conversations/helpers.js';
import { createTenant, createUser, type UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SETTINGS = '/api/v1/settings/channels';
const WEBHOOK = '/api/v1/webhooks/whatsapp';
const SLUG = 'lab-vida';

const ENV_SECRET = 'segredo-global-da-instalacao';
const LAB_SECRET = 'segredo-do-laboratorio-1234';
const LAB_TOKEN = 'EAAG-token-do-laboratorio-9f2a';

/** Env vars fixadas: o teste nao pode depender do `.env` da maquina. */
const ENV_FALLBACK: Omit<WhatsAppCredentials, 'tenantId'> = {
  phoneNumberId: 'numero-da-env',
  apiUrl: '',
  apiToken: 'token-global-da-instalacao',
  webhookSecret: ENV_SECRET,
  isActive: true,
  apiTokenRevoked: false,
  connectionMode: 'cloud_api',
};

let db: DbClient;
let app: TestApp;
let whatsapp: WhatsAppService;
let admin: UserRecord;
let tenantId: string;

function inboundPayload(text: string): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '5511987654321', profile: { name: 'Joao' } }],
              messages: [
                {
                  id: `wamid.${text}`,
                  from: '5511987654321',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Webhook assinado com `secret`. A resposta e SEMPRE 200 (nao e oraculo). */
async function postWebhook(text: string, secret: string): Promise<void> {
  const body = JSON.stringify(inboundPayload(text));
  const response = await app.agent
    .post(`${WEBHOOK}/${SLUG}`)
    .set('x-hub-signature-256', signWebhookBody(body, secret))
    .set('Content-Type', 'application/json')
    .send(body)
    .expect(200);
  expect(response.body).toEqual({ received: true });
}

async function patchChannel(channel: Record<string, unknown>): Promise<void> {
  await app.agent
    .patch(SETTINGS)
    .set(app.auth(admin))
    .send({ channels: [{ channel: 'whatsapp', ...channel }] })
    .expect(200);
}

/** Colunas cruas — so o teste le isto; a API nunca. */
async function rawChannel(): Promise<{ api_token: string | null; webhook_secret: string | null }> {
  const result = await db.withoutTenant((tx) =>
    tx.query<{ api_token: string | null; webhook_secret: string | null }>(
      `SELECT api_token, webhook_secret FROM tenant_channels
        WHERE tenant_id = $1 AND channel = 'whatsapp'`,
      [tenantId],
    ),
  );
  const row = result.rows[0];
  if (!row) throw new Error('linha de tenant_channels nao existe');
  return row;
}

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  whatsapp = new WhatsAppService({
    credentials: createTenantCredentialsResolver(db, { fallback: ENV_FALLBACK }),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  app = await createTestApp({
    db,
    modules: [channelSettingsModule, makeWebhookModule({ whatsapp })],
  });

  const tenant = await createTenant({ name: 'Lab Vida', slug: SLUG, db });
  tenantId = tenant.id;
  admin = await createUser({ tenantId, role: 'admin', name: 'Admin Ana', db });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('D-074 — desligar o canal desliga a ENTRADA', () => {
  it('canal ativo aceita o webhook; `isActive: false` recusa a MESMA requisicao', async () => {
    await patchChannel({ isActive: true, webhookSecret: LAB_SECRET });

    await postWebhook('antes', LAB_SECRET);
    expect(await countConversations(tenantId)).toBe(1);
    expect(await countMessages(tenantId)).toBe(1);

    // O gesto que o contrato manda fazer quando o token vaza.
    await patchChannel({ isActive: false });

    await postWebhook('depois', LAB_SECRET);
    // Nada nasceu: nem conversa, nem mensagem, nem paciente.
    expect(await countConversations(tenantId)).toBe(1);
    expect(await countMessages(tenantId)).toBe(1);

    // E religar volta a funcionar — o kill switch nao e via de mao unica.
    await patchChannel({ isActive: true });
    await postWebhook('religado', LAB_SECRET);
    expect(await countMessages(tenantId)).toBe(2);
  });

  it('canal desligado tambem nao ENVIA — nem pelo token guardado', async () => {
    await patchChannel({ isActive: true, apiToken: LAB_TOKEN, webhookSecret: LAB_SECRET });
    await expect(whatsapp.send(tenantId, '5511987654321', 'oi')).resolves.toMatchObject({
      externalId: expect.stringContaining('wamid.mock.'),
    });

    await patchChannel({ isActive: false });
    await expect(whatsapp.send(tenantId, '5511987654321', 'oi')).rejects.toThrow(/desativad/i);
  });
});

describe('D-073 emendada — revogar nao cai no segredo global', () => {
  it('`webhookSecret: null` revoga: o segredo da env var NAO passa a valer', async () => {
    await patchChannel({ isActive: true, webhookSecret: LAB_SECRET });
    await postWebhook('com-segredo-do-lab', LAB_SECRET);
    expect(await countMessages(tenantId)).toBe(1);

    // O admin descobre que o segredo vazou e o apaga (contrato §6).
    await patchChannel({ webhookSecret: null });

    // A tela confirma que nao ha segredo configurado...
    const view = await app.agent.get(SETTINGS).set(app.auth(admin)).expect(200);
    const channel = (view.body as { channels: Array<{ webhookSecretSet: boolean }> }).channels[0];
    expect(channel?.webhookSecretSet).toBe(false);

    // ...e NADA entra: nem com o segredo antigo, nem com o segredo GLOBAL da
    // instalacao (que era o buraco: `stored ?? env`).
    await postWebhook('com-segredo-antigo', LAB_SECRET);
    await postWebhook('com-segredo-da-env', ENV_SECRET);
    await postWebhook('sem-segredo', '');
    expect(await countMessages(tenantId)).toBe(1);
  });

  it('`apiToken: null` revoga a SAIDA — nao volta a sair pelo numero global', async () => {
    await patchChannel({ isActive: true, apiToken: LAB_TOKEN });
    await expect(whatsapp.send(tenantId, '5511987654321', 'oi')).resolves.toBeTruthy();

    await patchChannel({ apiToken: null });
    await expect(whatsapp.send(tenantId, '5511987654321', 'oi')).rejects.toThrow(/revogad/i);
  });

  it('quem NUNCA configurou continua caindo na env var (o fallback de D-073 vive)', async () => {
    // Linha existe (o lab conectou o numero) mas nunca gravou segredo nenhum:
    // coluna NULL, e nao a sentinela de revogacao.
    await patchChannel({ isActive: true, phoneNumberId: 'numero-do-lab' });

    await postWebhook('pela-env', ENV_SECRET);
    expect(await countMessages(tenantId)).toBe(1);
  });
});

describe('D-076 — credencial cifrada em repouso', () => {
  it('a coluna nao guarda o token em claro, e a mascara continua correta', async () => {
    vi.stubEnv('CHANNEL_SECRET_KEY', 'chave-de-teste-com-mais-de-32-caracteres-aqui');

    const response = await app.agent
      .patch(SETTINGS)
      .set(app.auth(admin))
      .send({ channels: [{ channel: 'whatsapp', apiToken: LAB_TOKEN, webhookSecret: LAB_SECRET }] })
      .expect(200);

    const raw = await rawChannel();
    expect(raw.api_token).not.toBe(LAB_TOKEN);
    expect(raw.webhook_secret).not.toBe(LAB_SECRET);
    expect(raw.api_token?.startsWith('enc:v1:')).toBe(true);
    expect(raw.webhook_secret?.startsWith('enc:v1:')).toBe(true);
    // O dump nao pode conter nem um pedaco do segredo.
    expect(JSON.stringify(raw)).not.toContain('9f2a');

    // A tela continua vendo os 4 ultimos do valor REAL (nao do ciphertext).
    const channel = (response.body as { channels: Array<{ apiTokenMasked: string | null }> })
      .channels[0];
    expect(channel?.apiTokenMasked).toBe('••••••••9f2a');
  });

  it('o segredo cifrado continua validando o HMAC do webhook', async () => {
    vi.stubEnv('CHANNEL_SECRET_KEY', 'chave-de-teste-com-mais-de-32-caracteres-aqui');
    await patchChannel({ isActive: true, webhookSecret: LAB_SECRET });

    await postWebhook('cifrado', LAB_SECRET);
    expect(await countMessages(tenantId)).toBe(1);

    // E o segredo GLOBAL continua sem valer para quem tem o proprio.
    await postWebhook('pela-env', ENV_SECRET);
    expect(await countMessages(tenantId)).toBe(1);
  });
});
