/**
 * `syncEvolutionWebhooks` (CRMLAB-66, D-223): no boot, toda instância `qr` já
 * criada recebe de novo o `/webhook/set` com `EVOLUTION_WEBHOOK_EVENTS` — a
 * instância antiga passa a receber evento novo sem script e sem ninguém entrar
 * na VPS. Nunca lança.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../src/db/types.js';
import {
  evolutionInstanceName,
  type EvolutionClient,
  type EvolutionWebhookConfig,
} from '../../src/lib/evolution-client.js';
import { syncEvolutionWebhooks } from '../../src/services/channel-settings.service.js';
import { createTenant } from '../helpers/factories.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';

let db: DbClient;

function fakeClient(options: { missing?: Set<string>; broken?: Set<string> } = {}) {
  const calls: Array<{ instanceName: string; webhook: EvolutionWebhookConfig }> = [];
  const unused = () => Promise.reject(new Error('nao usado'));
  const client: EvolutionClient = {
    createInstance: unused,
    getQr: unused,
    getStatus: unused,
    logout: unused,
    sendText: unused,
    sendMedia: unused,
    sendReaction: unused,
    async setWebhook(instanceName, webhook) {
      if (options.missing?.has(instanceName)) {
        throw new Error(`Evolution API respondeu 404: The "${instanceName}" instance does not exist`);
      }
      if (options.broken?.has(instanceName)) throw new Error('Evolution API respondeu 502');
      calls.push({ instanceName, webhook });
    },
  };
  return { client, calls };
}

async function channel(tenantId: string, mode: 'qr' | 'cloud_api'): Promise<void> {
  await db.withoutTenant((tx) =>
    tx.query(
      `INSERT INTO tenant_channels (tenant_id, channel, connection_mode) VALUES ($1, 'whatsapp', $2)`,
      [tenantId, mode],
    ),
  );
}

beforeEach(async () => {
  db = await getTestDb();
  await resetDatabase(db);
  process.env.EVOLUTION_WEBHOOK_BASE_URL = 'https://crm.local/';
  process.env.EVOLUTION_WEBHOOK_TOKEN = 'token-sync';
});

afterEach(() => {
  delete process.env.EVOLUTION_WEBHOOK_BASE_URL;
  delete process.env.EVOLUTION_WEBHOOK_TOKEN;
});

describe('syncEvolutionWebhooks (D-223)', () => {
  it('reaplica o webhook em toda instância qr — e só nelas', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const meta = await createTenant();
    await channel(a.id, 'qr');
    await channel(b.id, 'qr');
    await channel(meta.id, 'cloud_api');
    const { client, calls } = fakeClient();

    const result = await syncEvolutionWebhooks({ db, evolutionClient: client });

    expect(result).toEqual({ updated: 2, missing: 0, failed: 0 });
    expect(calls.map((c) => c.instanceName).sort()).toEqual(
      [evolutionInstanceName(a.id), evolutionInstanceName(b.id)].sort(),
    );
    expect(calls.find((c) => c.instanceName === evolutionInstanceName(a.id))?.webhook).toEqual({
      url: `https://crm.local/api/v1/webhooks/evolution/${a.id}`,
      token: 'token-sync',
    });
  });

  it('instância ausente é contada e gateway com erro não derruba os outros nem lança', async () => {
    const gone = await createTenant();
    const broken = await createTenant();
    const ok = await createTenant();
    for (const t of [gone, broken, ok]) await channel(t.id, 'qr');
    const { client, calls } = fakeClient({
      missing: new Set([evolutionInstanceName(gone.id)]),
      broken: new Set([evolutionInstanceName(broken.id)]),
    });

    const result = await syncEvolutionWebhooks({ db, evolutionClient: client });

    expect(result).toEqual({ updated: 1, missing: 1, failed: 1 });
    expect(calls.map((c) => c.instanceName)).toEqual([evolutionInstanceName(ok.id)]);
  });

  it('sem URL de webhook configurada não chama o gateway', async () => {
    delete process.env.EVOLUTION_WEBHOOK_BASE_URL;
    const t = await createTenant();
    await channel(t.id, 'qr');
    const { client, calls } = fakeClient();
    await syncEvolutionWebhooks({ db, evolutionClient: client });
    expect(calls).toHaveLength(0);
  });

  it('laboratório inativo fica de fora', async () => {
    const t = await createTenant();
    await channel(t.id, 'qr');
    await db.withoutTenant((tx) => tx.query('UPDATE tenants SET is_active = FALSE WHERE id = $1', [t.id]));
    const { client, calls } = fakeClient();
    await syncEvolutionWebhooks({ db, evolutionClient: client });
    expect(calls).toHaveLength(0);
  });
});
