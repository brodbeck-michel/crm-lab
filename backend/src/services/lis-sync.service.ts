/**
 * LisSyncService — SERVICES.md §24 (CRMLAB-52, D-185/D-186/D-187).
 *
 * Configuracao e execucao da sincronizacao dos orcamentos pela API do Bitlab.
 * Grava em `lis_budgets` SO por `LisImportService.ingestRows` — nao existe um
 * segundo upsert (D-185 item 3).
 *
 * Uma rodada le TODAS as paginas antes de gravar: se uma pagina falhar, nada e
 * gravado, a marca d'agua nao anda e a proxima rodada rele a mesma janela (o
 * upsert e idempotente, BUSINESS_RULES.md §11.1).
 */
import type {
  LisIntegrationSettings,
  LisSyncErrorKind,
  LisSyncRunResult,
  UpdateLisIntegrationRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  BITLAB_ERROR_MESSAGES,
  BitlabError,
  isBitlabError,
  saoPauloDateTime,
  watermarkToBitlabDateTime,
  type BitlabClient,
} from '../lib/bitlab-client.js';
import type { LisSpreadsheetRow } from '../lib/lis-spreadsheet.js';
import { logger } from '../lib/logger.js';
import {
  LisSyncSettingsRepository,
  type LisSyncSettingsView,
} from '../repositories/lis-sync-settings.repository.js';
import type { AuditService } from './audit.service.js';
import type { LisImportService } from './lis-import.service.js';

export const PAGE_SIZE = 500;
/** Teto de paginas por rodada (D-185 item 2): protege de um `temProxima` que nunca vira false. */
export const MAX_PAGES = 200;

const MANAGER_ROLES = ['manager', 'admin'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trava por tenant, no MODULO (e nao na instancia): o agendador do `main.ts` e
 * o "Sincronizar agora" da rota criam services diferentes, e a trava tem que
 * ser a mesma. O backend roda numa instancia so (D-185 item 5).
 */
const running = new Set<string>();

export interface LisSyncService {
  getSettings(ctx: TenantContext): Promise<LisIntegrationSettings>;
  updateSettings(ctx: TenantContext, dto: UpdateLisIntegrationRequest): Promise<LisIntegrationSettings>;
  runNow(ctx: TenantContext): Promise<LisSyncRunResult>;
  runScheduledTick(): Promise<void>;
}

export interface LisSyncServiceDeps {
  db: DbClient;
  audit: AuditService;
  lisImport: LisImportService;
  bitlab: BitlabClient;
  intervalMs: number;
  initialDays: number;
  now?: () => Date;
}

interface RunSummary {
  status: 'completed' | 'failed';
  received: number;
  importId: string | null;
  rowsAccepted: number;
  proposalsWon: number;
  watermark: string | null;
  error: { kind: LisSyncErrorKind; message: string } | null;
  view: LisSyncSettingsView;
}

function assertManagerOrAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function assertAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
  }
}

/** Marcas no mesmo formato ISO comparam por texto. */
function maxWatermark(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

export function createLisSyncService(deps: LisSyncServiceDeps): LisSyncService {
  const repo = new LisSyncSettingsRepository(deps.db);
  const now = deps.now ?? (() => new Date());
  const intervalMinutes = Math.round(deps.intervalMs / 60_000);

  function present(tenantId: string, view: LisSyncSettingsView): LisIntegrationSettings {
    return {
      enabled: view.enabled,
      apiKeySet: view.apiKeyMasked !== null,
      apiKeyMasked: view.apiKeyMasked,
      watermark: view.watermark,
      lastRunAt: view.lastRunAt,
      lastSuccessAt: view.lastSuccessAt,
      lastError: view.lastError,
      running: running.has(tenantId),
      intervalMinutes,
    };
  }

  function windowStart(watermark: string | null): string {
    const fromMark = watermark ? watermarkToBitlabDateTime(watermark) : null;
    if (fromMark) return fromMark;
    const start = new Date(now().getTime() - deps.initialDays * DAY_MS);
    return `${saoPauloDateTime(start).slice(0, 10)} 00:00:00`;
  }

  /** Chama o Bitlab ate a ultima pagina. Lanca `BitlabError`. */
  async function fetchAll(
    tenantId: string,
    apiKey: string,
    watermark: string | null,
  ): Promise<{ rows: LisSpreadsheetRow[]; watermark: string | null }> {
    const dataInicio = windowStart(watermark);
    const dataFim = saoPauloDateTime(now());
    const rows: LisSpreadsheetRow[] = [];
    let highest: string | null = null;
    let notices: string[] = [];

    for (let pagina = 1; ; pagina += 1) {
      if (pagina > MAX_PAGES) {
        throw new BitlabError('contract', `mais de ${MAX_PAGES} paginas numa rodada`);
      }
      const page = await deps.bitlab.fetchBudgetsPage(apiKey, {
        dataInicio,
        dataFim,
        pagina,
        tamanhoPagina: PAGE_SIZE,
      });
      rows.push(...page.rows);
      highest = maxWatermark(highest, page.watermark);
      if (page.deprecationNotices.length > 0) notices = page.deprecationNotices;
      if (!page.hasNext) break;
    }

    if (notices.length > 0) {
      logger.warn('lis_sync.bitlab_deprecation', { tenantId, notices });
    }
    return { rows, watermark: highest };
  }

  async function runForTenant(tenantId: string, triggeredBy: string | null): Promise<RunSummary | null> {
    running.add(tenantId);
    try {
      const started = await repo.startRun(tenantId);
      if (!started) return null;

      let fetched: { rows: LisSpreadsheetRow[]; watermark: string | null };
      try {
        fetched = await fetchAll(tenantId, started.apiKey, started.watermark);
      } catch (error) {
        const kind: LisSyncErrorKind = isBitlabError(error) ? error.kind : 'unavailable';
        const message = isBitlabError(error) ? error.userMessage : BITLAB_ERROR_MESSAGES.unavailable;
        logger.warn('lis_sync.failed', {
          tenantId,
          kind,
          detail: error instanceof Error ? error.message : 'erro desconhecido',
        });
        const view = await repo.finishRun(tenantId, {
          success: null,
          error: message,
          disable: kind === 'auth',
        });
        return {
          status: 'failed',
          received: 0,
          importId: null,
          rowsAccepted: 0,
          proposalsWon: 0,
          watermark: started.watermark,
          error: { kind, message },
          view,
        };
      }

      let importId: string | null = null;
      let rowsAccepted = 0;
      let proposalsWon = 0;
      if (fetched.rows.length > 0) {
        const imported = await deps.lisImport.ingestRows(
          { tenantId, createdBy: triggeredBy },
          fetched.rows,
          { kind: 'sync' },
        );
        importId = imported.id;
        rowsAccepted = imported.rowsAccepted ?? 0;
        proposalsWon = imported.proposalsWon ?? 0;
        if (imported.status === 'failed') {
          // Falha de banco no meio dos chunks: a marca NAO anda — a proxima
          // rodada rele a janela, e o upsert absorve o que ja entrou.
          const message = 'Falha ao gravar os orçamentos recebidos. A próxima rodada tenta de novo.';
          logger.warn('lis_sync.ingest_failed', { tenantId, importId });
          const view = await repo.finishRun(tenantId, { success: null, error: message });
          return {
            status: 'failed',
            received: fetched.rows.length,
            importId,
            rowsAccepted,
            proposalsWon,
            watermark: started.watermark,
            error: { kind: 'unavailable', message },
            view,
          };
        }
      }

      const view = await repo.finishRun(tenantId, { success: { watermark: fetched.watermark }, error: null });
      logger.info('lis_sync.completed', { tenantId, received: fetched.rows.length, importId });
      return {
        status: 'completed',
        received: fetched.rows.length,
        importId,
        rowsAccepted,
        proposalsWon,
        watermark: view.watermark,
        error: null,
        view,
      };
    } finally {
      running.delete(tenantId);
    }
  }

  return {
    async getSettings(ctx) {
      assertManagerOrAdmin(ctx);
      return present(ctx.tenantId, await repo.get(ctx.tenantId));
    },

    async updateSettings(ctx, dto) {
      assertAdmin(ctx);
      const before = await repo.get(ctx.tenantId);

      if (dto.enabled === true && dto.apiKey !== null) {
        const willHaveKey = typeof dto.apiKey === 'string' || before.apiKeyMasked !== null;
        if (!willHaveKey) {
          throw new BusinessError('VALIDATION_ERROR', { fields: { enabled: 'requires_api_key' } });
        }
      }

      const patch = {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.apiKey !== undefined ? { apiKey: dto.apiKey } : {}),
      };
      const after = await repo.update(ctx.tenantId, patch, ctx.userId);

      const redact = (view: LisSyncSettingsView): Record<string, unknown> => ({
        enabled: view.enabled,
        apiKey: view.apiKeyMasked === null ? null : '[REDACTED]',
      });
      await deps.audit.record(ctx, {
        action: 'update_lis_integration',
        entityType: 'lis_sync_settings',
        entityId: ctx.tenantId,
        oldValues: redact(before),
        newValues: redact(after),
      });

      return present(ctx.tenantId, after);
    },

    async runNow(ctx) {
      assertManagerOrAdmin(ctx);
      if (running.has(ctx.tenantId)) {
        throw new BusinessError('CONFLICT', { reason: 'lis_sync_running' });
      }
      const summary = await runForTenant(ctx.tenantId, ctx.userId);
      if (!summary) {
        throw new BusinessError('CONFLICT', { reason: 'lis_sync_not_configured' });
      }

      await deps.audit.record(ctx, {
        action: 'run_lis_sync',
        entityType: 'lis_sync_settings',
        entityId: ctx.tenantId,
        newValues: { status: summary.status, received: summary.received, importId: summary.importId },
      });

      const { view, ...result } = summary;
      return { ...result, settings: present(ctx.tenantId, view) };
    },

    async runScheduledTick() {
      let tenantIds: string[];
      try {
        tenantIds = await repo.listEnabledTenantIds();
      } catch (error) {
        logger.warn('lis_sync.tick_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Em serie: um laboratorio por vez nao compete com a tela pelo pool.
      for (const tenantId of tenantIds) {
        if (running.has(tenantId)) continue;
        try {
          await runForTenant(tenantId, null);
        } catch (error) {
          logger.warn('lis_sync.tenant_failed', {
            tenantId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}

/** So para teste: garante que nenhuma trava sobrou entre casos. */
export function resetLisSyncLocksForTest(): void {
  running.clear();
}
