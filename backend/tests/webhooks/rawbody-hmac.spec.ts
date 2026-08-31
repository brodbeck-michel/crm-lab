/**
 * HMAC do webhook da Meta sobre os BYTES REAIS do corpo (`req.rawBody`), nao
 * sobre uma reserializacao de `req.body` ja parseado.
 *
 * `rawBodyOf` (webhook.routes.ts) ja prefere `req.rawBody` quando ele existe —
 * o que falta e o kernel (`app.ts`) preencher esse campo. Ate o fix, o
 * fallback `JSON.stringify(req.body ?? {})` reconstroi o JSON SEM os espacos
 * do corpo original: mesmas chaves, mesma ordem, bytes diferentes — o
 * suficiente para o HMAC (calculado sobre os bytes que trafegaram) nunca bater
 * com a reserializacao "compacta" do `JSON.stringify`. So comparar contra
 * `req.rawBody` (os bytes exatos) resolve; comparar contra qualquer
 * reserializacao nunca resolveria, mesmo reordenando chaves de volta.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  type WhatsAppCredentials,
  type WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';
import { countConversations, countMessages } from '../conversations/helpers.js';
import { createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

const SECRET = 'webhook-secret-de-teste';
const WEBHOOK = '/api/v1/webhooks/whatsapp';

/**
 * Resolver simples: a rota `/whatsapp` (sem `:tenant`) resolve o tenant pela
 * identidade vazia (`tenantIdentityOf` devolve `''` quando nao ha `:tenant` na
 * URL nem `tenantSlug`/`tenantId`/`tenant` no corpo) — igual ao que a Meta
 * manda quando o laboratorio configura a URL de webhook sem sufixo.
 */
function credentialsResolver(tenantId: string, secret: string): WhatsAppCredentialsResolver {
  const credentials: WhatsAppCredentials = {
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: secret,
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
  };
  return {
    forTenant: async () => credentials,
    byWebhookIdentity: async (identity) => (identity === '' ? credentials : null),
  };
}

function signatureOf(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('HMAC do webhook usa os bytes reais do corpo (req.rawBody)', () => {
  it('assinatura calculada sobre os bytes originais (com espacos que a reserializacao perde) ainda valida', async () => {
    const db = await getTestDb();
    await resetDatabase(db);
    const tenant = await createTenant();

    const whatsapp = new WhatsAppService({
      credentials: credentialsResolver(tenant.id, SECRET),
      driver: new MockWhatsAppDriver(),
      queue: createInMemoryQueue({ sleep: async () => undefined }),
    });
    const app: TestApp = await createTestApp({
      db,
      modules: [makeWebhookModule({ whatsapp })],
    });

    // Corpo com espacos apos ":" e "," — JSON.stringify(JSON.parse(rawBody))
    // produz `{"phone":"5548999998888","text":"Ola, tudo bem?","name":"Maria"}`,
    // SEM esses espacos: bytes diferentes dos que trafegaram, mesmo com a MESMA
    // ordem de chaves. Uma assinatura calculada sobre `rawBody` so pode bater
    // comparando contra os bytes reais (`req.rawBody`), nunca contra qualquer
    // reserializacao do objeto ja parseado.
    const rawBody =
      '{"phone": "5548999998888", "text": "Ola, tudo bem?", "name": "Maria"}';
    const signature = signatureOf(rawBody, SECRET);

    const response = await app.agent
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });

    // Nao e so 200 (que a rota sempre devolve, SECURITY.md "nao vira oraculo"):
    // a mensagem tem que ter sido de fato processada — conversa criada e
    // mensagem gravada no tenant certo.
    expect(await countConversations(tenant.id)).toBe(1);
    expect(await countMessages(tenant.id)).toBe(1);
  });

  it('assinatura sobre os bytes originais, mas comparada errado (sem rawBody), e recusada — controle negativo', async () => {
    // Mesmo cenario, secret ERRADO: prova que a rota nao aceita QUALQUER
    // assinatura — soh a calculada com o segredo certo sobre os bytes certos.
    const db = await getTestDb();
    await resetDatabase(db);
    const tenant = await createTenant();

    const whatsapp = new WhatsAppService({
      credentials: credentialsResolver(tenant.id, SECRET),
      driver: new MockWhatsAppDriver(),
      queue: createInMemoryQueue({ sleep: async () => undefined }),
    });
    const app: TestApp = await createTestApp({
      db,
      modules: [makeWebhookModule({ whatsapp })],
    });

    const rawBody = '{"phone": "5548999998888", "text": "invasao", "name": "Maria"}';
    const wrongSignature = signatureOf(rawBody, 'segredo-errado');

    const response = await app.agent
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', wrongSignature)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(await countMessages(tenant.id)).toBe(0);
  });
});
