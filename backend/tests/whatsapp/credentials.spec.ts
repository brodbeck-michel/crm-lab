/**
 * Credenciais do canal: TABELA PRIMEIRO, ENV VAR DEPOIS (D-024).
 *
 * O resolver default de producao le `tenant_channels` pelo
 * `ChannelSettingsService` (o unico ponto que enxerga o segredo em claro,
 * D-064) e cai nas env vars quando o laboratorio ainda nao conectou o canal —
 * sem esse fallback, um ambiente ja configurado quebraria na subida.
 *
 * A prova de precedencia nao olha um campo em memoria: ela ASSINA o webhook com
 * um segredo e verifica o efeito no banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import type { DbClient } from '../../src/db/types.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  createTenantCredentialsResolver,
  mergeCredentials,
  signWebhookBody,
  type WhatsAppCredentials,
} from '../../src/services/whatsapp.service.js';
import { countConversations, countMessages } from '../conversations/helpers.js';
import { createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const ENV_SECRET = 'segredo-da-env-var';
const TABLE_SECRET = 'segredo-da-tabela-do-lab';
const WEBHOOK = '/api/v1/webhooks/whatsapp';

/** As env vars do ambiente, fixadas para o teste nao depender do `.env`. */
const ENV_FALLBACK: Omit<WhatsAppCredentials, 'tenantId'> = {
  phoneNumberId: 'numero-da-env',
  apiUrl: '',
  apiToken: 'token-da-env',
  webhookSecret: ENV_SECRET,
  isActive: true,
  apiTokenRevoked: false,
  connectionMode: 'cloud_api',
};

interface ChannelSeed {
  tenantId: string;
  phoneNumberId?: string | null;
  apiToken?: string | null;
  webhookSecret?: string | null;
  db?: DbClient;
}

/** Linha de `tenant_channels` escrita direto — o cenario existe ANTES do teste. */
async function seedChannel(input: ChannelSeed): Promise<void> {
  const db = input.db ?? (await getTestDb());
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_channels (tenant_id, channel, phone_number_id, api_token, webhook_secret)
       VALUES ($1, 'whatsapp', $2, $3, $4)`,
      [
        input.tenantId,
        input.phoneNumberId ?? null,
        input.apiToken ?? null,
        input.webhookSecret ?? null,
      ],
    ),
  );
}

function payload(phone: string, text: string): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: phone, profile: { name: 'Joao' } }],
              messages: [
                { id: `wamid.${phone}.${text}`, from: phone, type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * App com o resolver REAL de producao (`createTenantCredentialsResolver`), so
 * com as env vars injetadas — a leitura de `tenant_channels` acontece pelo
 * `ChannelSettingsService` de verdade.
 */
async function buildApp(): Promise<TestApp> {
  const db = await getTestDb();
  const whatsapp = new WhatsAppService({
    credentials: createTenantCredentialsResolver(db, { fallback: ENV_FALLBACK }),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
}

describe('mergeCredentials — precedencia campo a campo', () => {
  it('a tabela vence; o que a tabela nao tem cai na env var', () => {
    const completa = mergeCredentials(
      't1',
      {
        phoneNumberId: 'numero-do-lab',
        apiToken: 'token-do-lab',
        webhookSecret: TABLE_SECRET,
        isActive: true,
        connectionMode: 'cloud_api',
      },
      ENV_FALLBACK,
    );
    expect(completa).toEqual({
      tenantId: 't1',
      phoneNumberId: 'numero-do-lab',
      apiUrl: '',
      apiToken: 'token-do-lab',
      webhookSecret: TABLE_SECRET,
      isActive: true,
      apiTokenRevoked: false,
      connectionMode: 'cloud_api',
    });

    // Linha existe mas o laboratorio ainda nao girou o segredo do webhook.
    const parcial = mergeCredentials(
      't1',
      {
        phoneNumberId: 'numero-do-lab',
        apiToken: null,
        webhookSecret: null,
        isActive: true,
        connectionMode: 'qr',
      },
      ENV_FALLBACK,
    );
    expect(parcial.phoneNumberId).toBe('numero-do-lab');
    expect(parcial.apiToken).toBe('token-da-env');
    expect(parcial.webhookSecret).toBe(ENV_SECRET);
    expect(parcial.connectionMode).toBe('qr');

    // Sem linha nenhuma: tudo da env var.
    expect(mergeCredentials('t1', null, ENV_FALLBACK)).toEqual({ tenantId: 't1', ...ENV_FALLBACK });
  });
});

describe('resolver de credenciais — tabela primeiro, env var depois (D-024)', () => {
  let app: TestApp;

  beforeEach(async () => {
    await resetDatabase();
    app = await buildApp();
    app.wsHub.clear();
  });

  const post = async (slug: string, body: string, secret: string): Promise<void> => {
    await app.agent
      .post(`${WEBHOOK}/${slug}`)
      .set('x-hub-signature-256', signWebhookBody(body, secret))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  };

  it('o segredo da tabela valida o HMAC e o da env var deixa de valer', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    await seedChannel({ tenantId: tenant.id, webhookSecret: TABLE_SECRET });

    // Assinado com a env var: recusado, porque a tabela tem precedencia.
    await post('lab-vida', JSON.stringify(payload('5511987654321', 'com-env')), ENV_SECRET);
    expect(await countConversations(tenant.id)).toBe(0);
    expect(await countMessages(tenant.id)).toBe(0);

    // Assinado com o segredo da tabela: aceito.
    await post('lab-vida', JSON.stringify(payload('5511987654321', 'com-tabela')), TABLE_SECRET);
    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('sem linha na tabela, a env var continua valendo', async () => {
    const tenant = await createTenant({ slug: 'lab-sem-canal' });

    await post('lab-sem-canal', JSON.stringify(payload('5511987654321', 'oi')), ENV_SECRET);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('linha na tabela sem segredo cai na env var (fallback campo a campo)', async () => {
    const tenant = await createTenant({ slug: 'lab-so-numero' });
    await seedChannel({ tenantId: tenant.id, phoneNumberId: 'numero-do-lab', webhookSecret: null });

    await post('lab-so-numero', JSON.stringify(payload('5511987654321', 'oi')), ENV_SECRET);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('cada laboratorio so valida com o PROPRIO segredo', async () => {
    const alfa = await createTenant({ slug: 'lab-alfa' });
    const beta = await createTenant({ slug: 'lab-beta' });
    await seedChannel({ tenantId: alfa.id, webhookSecret: 'segredo-do-alfa-123' });
    await seedChannel({ tenantId: beta.id, webhookSecret: 'segredo-do-beta-123' });

    const body = JSON.stringify(payload('5511987654321', 'oi'));
    // O segredo do beta nao abre a porta do alfa.
    await post('lab-alfa', body, 'segredo-do-beta-123');
    expect(await countMessages(alfa.id)).toBe(0);

    await post('lab-alfa', body, 'segredo-do-alfa-123');
    expect(await countMessages(alfa.id)).toBe(1);
    expect(await countMessages(beta.id)).toBe(0);
  });

  it('SEGREDO VAZIO recusa tudo — na tabela e na env var', async () => {
    const db = await getTestDb();
    const semNada = await createTenant({ slug: 'lab-sem-segredo' });
    const comVazio = await createTenant({ slug: 'lab-segredo-vazio' });
    await seedChannel({ tenantId: comVazio.id, webhookSecret: '' });

    const vazio: Omit<WhatsAppCredentials, 'tenantId'> = { ...ENV_FALLBACK, webhookSecret: '' };
    const semSegredo = await createTestApp({
      db,
      modules: [
        makeWebhookModule({
          whatsapp: new WhatsAppService({
            credentials: createTenantCredentialsResolver(db, { fallback: vazio }),
            driver: new MockWhatsAppDriver(),
            queue: createInMemoryQueue({ sleep: async () => undefined }),
          }),
        }),
      ],
    });

    const body = JSON.stringify(payload('5511987654321', 'oi'));
    for (const slug of ['lab-sem-segredo', 'lab-segredo-vazio']) {
      for (const assinatura of [signWebhookBody(body, ''), signWebhookBody(body, ENV_SECRET)]) {
        const response = await semSegredo.agent
          .post(`${WEBHOOK}/${slug}`)
          .set('x-hub-signature-256', assinatura)
          .set('Content-Type', 'application/json')
          .send(body)
          .expect(200);
        // Mesma resposta do caminho feliz: nao e oraculo.
        expect(response.body).toEqual({ received: true });
      }
    }

    expect(await countMessages(semNada.id)).toBe(0);
    expect(await countMessages(comVazio.id)).toBe(0);
  });
});
