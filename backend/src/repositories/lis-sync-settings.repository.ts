/**
 * Acesso a `lis_sync_settings` (SCHEMA.md §31 — CRMLAB-52, D-185/D-186).
 *
 * Segredo write-only, como `tenant_channels` (D-064): a leitura da tela
 * projeta colunas explicitamente e devolve so `apiKeyMasked`. `resolveApiKey`
 * e o UNICO metodo que decifra a chave, e o retorno dele vai direto para o
 * `BitlabClient` — nunca para um controller.
 *
 * `listEnabledTenantIds` e a UNICA leitura fora do contexto de tenant (D-186):
 * roda em `withoutTenant()` e projeta so `tenant_id`.
 */
import type { DbClient, DbTx } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/secret-box.js';
import { toIsoOrNull } from './row-mappers.js';

export const API_KEY_MASK_PREFIX = '••••••••';

export interface LisSyncSettingsView {
  enabled: boolean;
  apiKeyMasked: string | null;
  watermark: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface SettingsRow {
  enabled: boolean;
  api_key: string | null;
  watermark: string | null;
  last_run_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error: string | null;
}

const DEFAULT_VIEW: LisSyncSettingsView = {
  enabled: false,
  apiKeyMasked: null,
  watermark: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
};

function maskApiKey(stored: string | null): string | null {
  const plain = decryptSecret(stored);
  if (plain === null || plain.length === 0) return null;
  return API_KEY_MASK_PREFIX + plain.slice(-4);
}

function toView(row: SettingsRow): LisSyncSettingsView {
  return {
    enabled: row.enabled,
    apiKeyMasked: maskApiKey(row.api_key),
    watermark: row.watermark,
    lastRunAt: toIsoOrNull(row.last_run_at),
    lastSuccessAt: toIsoOrNull(row.last_success_at),
    lastError: row.last_error,
  };
}

async function selectView(tx: DbTx, tenantId: string): Promise<LisSyncSettingsView> {
  const result = await tx.query<SettingsRow>(
    `SELECT enabled, api_key, watermark, last_run_at, last_success_at, last_error
       FROM lis_sync_settings
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  return row ? toView(row) : { ...DEFAULT_VIEW };
}

export interface LisSyncSettingsPatch {
  enabled?: boolean;
  /** string grava (cifrada), `null` apaga, ausente preserva. */
  apiKey?: string | null;
}

export interface LisSyncRunOutcome {
  /** `null` = rodada sem sucesso: nao mexe em `last_success_at`/`watermark`. */
  success: { watermark: string | null } | null;
  error: string | null;
  /** `true` so na chave recusada (D-185 item 6). */
  disable?: boolean;
}

export class LisSyncSettingsRepository {
  constructor(private readonly db: DbClient) {}

  async get(tenantId: string): Promise<LisSyncSettingsView> {
    return this.db.withTenant(tenantId, (tx) => selectView(tx, tenantId));
  }

  /**
   * Upsert parcial. Apagar a chave desliga na mesma escrita (o CHECK
   * `lis_sync_settings_enabled_needs_key` recusaria o contrario).
   */
  async update(tenantId: string, patch: LisSyncSettingsPatch, updatedBy: string): Promise<LisSyncSettingsView> {
    return this.db.withTenant(tenantId, async (tx) => {
      const keyProvided = patch.apiKey !== undefined;
      const storedKey = patch.apiKey ? encryptSecret(patch.apiKey) : null;
      const enabled = patch.apiKey === null ? false : (patch.enabled ?? null);

      // O CHECK `enabled_needs_key` vale para a linha PROPOSTA do INSERT antes
      // do ON CONFLICT decidir que e UPDATE — sem chave no patch, a linha
      // proposta nasce desligada; o `enabled` real vem do DO UPDATE.
      await tx.query(
        `INSERT INTO lis_sync_settings (tenant_id, enabled, api_key, updated_by)
         VALUES ($1, COALESCE($2::boolean, false) AND $3::text IS NOT NULL, $3, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = COALESCE($2::boolean, lis_sync_settings.enabled),
           api_key = CASE WHEN $4::boolean THEN EXCLUDED.api_key ELSE lis_sync_settings.api_key END,
           updated_by = EXCLUDED.updated_by`,
        [tenantId, enabled, storedKey, keyProvided, updatedBy],
      );
      return selectView(tx, tenantId);
    });
  }

  /** `true` quando ha chave gravada (sem decifrar). */
  async hasApiKey(tenantId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ has_key: boolean }>(
        'SELECT api_key IS NOT NULL AS has_key FROM lis_sync_settings WHERE tenant_id = $1',
        [tenantId],
      );
      return result.rows[0]?.has_key ?? false;
    });
  }

  /**
   * UNICO ponto que decifra a chave. `null` = nao configurado ou desligado —
   * a rodada nao acontece. Grava `last_run_at` na mesma transacao.
   */
  async startRun(tenantId: string): Promise<{ apiKey: string; watermark: string | null } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ api_key: string | null; watermark: string | null }>(
        `UPDATE lis_sync_settings
            SET last_run_at = NOW()
          WHERE tenant_id = $1 AND enabled AND api_key IS NOT NULL
          RETURNING api_key, watermark`,
        [tenantId],
      );
      const row = result.rows[0];
      const apiKey = decryptSecret(row?.api_key ?? null);
      if (!row || !apiKey) return null;
      return { apiKey, watermark: row.watermark };
    });
  }

  async finishRun(tenantId: string, outcome: LisSyncRunOutcome): Promise<LisSyncSettingsView> {
    return this.db.withTenant(tenantId, async (tx) => {
      if (outcome.success) {
        await tx.query(
          `UPDATE lis_sync_settings
              SET last_success_at = NOW(),
                  last_error = NULL,
                  watermark = COALESCE($2, watermark)
            WHERE tenant_id = $1`,
          [tenantId, outcome.success.watermark],
        );
      } else {
        await tx.query(
          `UPDATE lis_sync_settings
              SET last_error = $2,
                  enabled = CASE WHEN $3::boolean THEN false ELSE enabled END
            WHERE tenant_id = $1`,
          [tenantId, outcome.error, outcome.disable ?? false],
        );
      }
      return selectView(tx, tenantId);
    });
  }

  /** D-186: fora do contexto de tenant, SO `tenant_id`. */
  async listEnabledTenantIds(): Promise<string[]> {
    return this.db.withoutTenant(async (tx) => {
      const result = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM lis_sync_settings
          WHERE enabled AND api_key IS NOT NULL
          ORDER BY tenant_id`,
      );
      return result.rows.map((r) => r.tenant_id);
    });
  }
}
