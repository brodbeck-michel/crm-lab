/**
 * LisRequisitionSyncService — SERVICES.md §24.2 (CRMLAB-200, D-338).
 *
 * Traz TODAS as requisicoes do Bitlab (com ou sem orcamento) para `lis_requisitions`, a fonte do
 * faturamento por medico. Mesma chave e mesmo `enabled` da sincronizacao de orcamentos; estado
 * proprio nas colunas `requisitions_*` de `lis_sync_settings`.
 *
 *  - Carga inicial: `emissao`, um dia por vez, de `since` ate hoje. Cada dia e gravado junto com o
 *    progresso, entao uma carga interrompida continua de onde parou.
 *  - Incremental: `alteracao`, janelas de no maximo 1 dia, da marca ate agora, com o cursor.
 *  - Ritmo: `callGapMs` entre chamadas; 429 espera e tenta de novo (limite de 60/min, D-337).
 *  - Falha nunca desliga nada (nem `auth`): a chave pode valer so para os orcamentos.
 */
import type { LisRequisitionsSyncStatus, LisSyncErrorKind } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  BITLAB_ERROR_MESSAGES,
  BitlabError,
  isBitlabError,
  saoPauloDateTime,
  shiftBitlabDateTime,
} from '../lib/bitlab-client.js';
import type {
  BitlabRequisitionsClient,
  BitlabRequisitionsPage,
  BitlabRequisitionsQuery,
  LisRequisitionRow,
} from '../lib/bitlab-requisitions-client.js';
import { logger } from '../lib/logger.js';
import { LisRequisitionRepository } from '../repositories/lis-requisition.repository.js';
import type { AuditService } from './audit.service.js';

export const REQUISITIONS_CALL_GAP_MS = 1500;
export const REQUISITIONS_RETRY_WAIT_MS = 60_000;
export const REQUISITIONS_MAX_RETRIES = 3;
export const REQUISITIONS_MAX_PAGES = 200;
export const REQUISITIONS_MAX_WINDOWS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Brasilia sem horario de verao desde 2019: UTC-3 fixo para converter o horario do agendador. */
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;

const REQUISITION_ERROR_MESSAGES: Record<LisSyncErrorKind, string> = {
  auth: 'O Bitlab recusou a chave para as requisições. Confira com o Bitlab se a chave vale para a consulta de requisições.',
  unavailable: 'O Bitlab não respondeu às requisições (fora do ar, limite de chamadas ou tempo esgotado). A próxima rodada continua de onde parou.',
  contract: 'A resposta de requisições do Bitlab veio num formato inesperado. Nada desta parte foi gravado.',
  rejected: 'O Bitlab recusou a consulta de requisições.',
};

/** Travas por tenant e por tique no MODULO (rota e agendador criam services diferentes). */
const running = new Set<string>();
let tickInProgress = false;

export interface LisRequisitionSyncService {
  getStatus(tenantId: string): Promise<LisRequisitionsSyncStatus>;
  /** Dispara em segundo plano. Devolve a promessa da rodada so para teste (`awaitRun`). */
  startNow(ctx: TenantContext): Promise<{ run: Promise<void> }>;
  runScheduledTick(): Promise<void>;
  runForTenant(tenantId: string): Promise<void>;
}

export interface LisRequisitionSyncServiceDeps {
  db: DbClient;
  audit: AuditService;
  bitlab: BitlabRequisitionsClient;
  since: string;
  scheduleTimes: string[];
  /** `false` = agendador desligado neste servidor (hml): `scheduleTimes` vai vazio para a tela. */
  schedulerEnabled: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  callGapMs?: number;
  retryWaitMs?: number;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function minText(a: string, b: string): string {
  return a < b ? a : b;
}

/** Instante UTC de `HH:mm` de Brasilia no dia `isoDate`. */
function slotInstant(isoDate: string, time: string): Date {
  return new Date(new Date(`${isoDate}T${time}:00Z`).getTime() + SAO_PAULO_OFFSET_MS);
}

/** O horario do agendador mais recente que ja passou hoje (Brasilia), ou `null`. */
export function latestDueSlot(now: Date, times: string[]): Date | null {
  const today = saoPauloDateTime(now).slice(0, 10);
  let latest: Date | null = null;
  for (const t of times) {
    const slot = slotInstant(today, t);
    if (slot.getTime() <= now.getTime() && (latest === null || slot > latest)) latest = slot;
  }
  return latest;
}

export function createLisRequisitionSyncService(deps: LisRequisitionSyncServiceDeps): LisRequisitionSyncService {
  const repo = new LisRequisitionRepository(deps.db);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const callGapMs = deps.callGapMs ?? REQUISITIONS_CALL_GAP_MS;
  const retryWaitMs = deps.retryWaitMs ?? REQUISITIONS_RETRY_WAIT_MS;
  let lastCallAt = 0;

  /** Uma chamada ao Bitlab respeitando o ritmo; 429 espera e tenta de novo. */
  async function call(apiKey: string, query: BitlabRequisitionsQuery): Promise<BitlabRequisitionsPage> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastCallAt + callGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      try {
        return await deps.bitlab.fetchRequisitionsPage(apiKey, query);
      } catch (error) {
        const rateLimited = isBitlabError(error) && error.kind === 'unavailable' && /HTTP 429/.test(error.message);
        if (!rateLimited || attempt >= REQUISITIONS_MAX_RETRIES - 1) throw error;
        logger.info('lis_requisitions_sync.rate_limited', { attempt: attempt + 1 });
        await sleep(retryWaitMs);
      }
    }
  }

  /** Le uma janela inteira (todas as paginas). */
  async function fetchWindow(
    apiKey: string,
    base: Omit<BitlabRequisitionsQuery, 'cursor'>,
    startCursor: string | null,
  ): Promise<{ rows: LisRequisitionRow[]; excluded: string[]; watermark: string | null; cursor: string | null }> {
    const rows: LisRequisitionRow[] = [];
    const excluded: string[] = [];
    let watermark: string | null = null;
    let cursor = startCursor;
    let lastCursor = startCursor;
    for (let page = 1; ; page += 1) {
      if (page > REQUISITIONS_MAX_PAGES) {
        throw new BitlabError('contract', `mais de ${REQUISITIONS_MAX_PAGES} paginas numa janela`);
      }
      const result = await call(apiKey, { ...base, cursor });
      rows.push(...result.rows);
      excluded.push(...result.excluded);
      if (result.watermark !== null && (watermark === null || result.watermark > watermark)) {
        watermark = result.watermark;
      }
      if (result.nextCursor !== null) lastCursor = result.nextCursor;
      if (!result.hasNext) break;
      if (result.nextCursor === null || result.nextCursor === cursor) {
        throw new BitlabError('contract', 'temProxima sem proximoCursor novo');
      }
      cursor = result.nextCursor;
    }
    return { rows, excluded, watermark, cursor: lastCursor };
  }

  async function initialLoad(tenantId: string, apiKey: string, loadNextDay: string | null, loadStartedAt: string | null): Promise<{ received: number; deleted: number }> {
    const startedAt = loadStartedAt ?? saoPauloDateTime(now());
    if (loadStartedAt === null) await repo.saveProgress(tenantId, { loadStartedAt: startedAt });
    const today = saoPauloDateTime(now()).slice(0, 10);
    let day = loadNextDay ?? deps.since;
    let received = 0;
    let deleted = 0;
    while (day <= today) {
      const window = await fetchWindow(
        apiKey,
        { dataInicio: `${day} 00:00:00`, dataFim: `${day} 23:59:59`, tipoData: 'emissao' },
        null,
      );
      const next = addDays(day, 1);
      const applied = await repo.applyBatch(tenantId, window.rows, window.excluded, { loadNextDay: next });
      received += applied.written;
      deleted += applied.deleted;
      day = next;
    }
    // A marca vira a hora em que a carga comecou: o que mudou durante ela volta no incremental.
    await repo.saveProgress(tenantId, { watermark: startedAt, cursor: null, loadNextDay: null });
    return { received, deleted };
  }

  async function incremental(tenantId: string, apiKey: string, watermark: string, storedCursor: string | null): Promise<{ received: number; deleted: number }> {
    const end = saoPauloDateTime(now());
    let start = watermark;
    let cursor = storedCursor;
    let received = 0;
    let deleted = 0;
    for (let i = 0; i < REQUISITIONS_MAX_WINDOWS; i += 1) {
      if (start >= end) break;
      const windowEnd = minText(shiftBitlabDateTime(start, DAY_MS - 1000), end);
      const reachedEnd = windowEnd === end;
      const window = await fetchWindow(apiKey, { dataInicio: start, dataFim: windowEnd, tipoData: 'alteracao' }, cursor);
      const nextMark = reachedEnd ? (window.watermark ?? start) : windowEnd;
      const applied = await repo.applyBatch(tenantId, window.rows, window.excluded, {
        watermark: nextMark,
        cursor: window.cursor,
      });
      received += applied.written;
      deleted += applied.deleted;
      if (reachedEnd) break;
      start = windowEnd;
      cursor = window.cursor;
    }
    return { received, deleted };
  }

  async function runForTenant(tenantId: string): Promise<void> {
    if (running.has(tenantId)) return;
    running.add(tenantId);
    try {
      const started = await repo.startRun(tenantId, now());
      if (!started) return;
      const state = await repo.getState(tenantId);
      const mode = state.watermark === null ? 'initial' : 'incremental';
      try {
        const result =
          state.watermark === null
            ? await initialLoad(tenantId, started.apiKey, state.loadNextDay, state.loadStartedAt)
            : await incremental(tenantId, started.apiKey, state.watermark, state.cursor);
        await repo.finishRun(tenantId, null);
        logger.info('lis_requisitions_sync.completed', { tenantId, mode, ...result });
      } catch (error) {
        const kind: LisSyncErrorKind = isBitlabError(error) ? error.kind : 'unavailable';
        const message = isBitlabError(error)
          ? kind === 'rejected' && error.userMessage !== BITLAB_ERROR_MESSAGES.rejected
            ? error.userMessage
            : REQUISITION_ERROR_MESSAGES[kind]
          : 'Falha ao gravar as requisições recebidas. A próxima rodada continua de onde parou.';
        logger.warn('lis_requisitions_sync.failed', {
          tenantId,
          mode,
          kind,
          detail: error instanceof Error ? error.message : 'erro desconhecido',
        });
        await repo.finishRun(tenantId, message);
      }
    } finally {
      running.delete(tenantId);
    }
  }

  return {
    async getStatus(tenantId) {
      const state = await repo.getState(tenantId);
      return {
        watermark: state.watermark,
        initialLoad: {
          since: deps.since,
          nextDay: state.watermark === null ? state.loadNextDay : null,
          done: state.watermark !== null,
        },
        lastRunAt: state.lastRunAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        running: running.has(tenantId),
        scheduleTimes: deps.schedulerEnabled ? [...deps.scheduleTimes] : [],
        total: state.total,
      };
    },

    async startNow(ctx) {
      if (ctx.role !== 'manager' && ctx.role !== 'admin') {
        throw new BusinessError('FORBIDDEN', { requiredRoles: ['manager', 'admin'] });
      }
      if (running.has(ctx.tenantId)) {
        throw new BusinessError('CONFLICT', { reason: 'lis_requisitions_sync_running' });
      }
      const state = await repo.getState(ctx.tenantId);
      const hasKey = await deps.db.withTenant(ctx.tenantId, async (tx) => {
        const r = await tx.query<{ ok: boolean }>(
          'SELECT (enabled AND api_key IS NOT NULL) AS ok FROM lis_sync_settings WHERE tenant_id = $1',
          [ctx.tenantId],
        );
        return r.rows[0]?.ok ?? false;
      });
      if (!hasKey) {
        throw new BusinessError('CONFLICT', { reason: 'lis_sync_not_configured' });
      }
      await deps.audit.record(ctx, {
        action: 'run_lis_requisitions_sync',
        entityType: 'lis_sync_settings',
        entityId: ctx.tenantId,
        newValues: { initialLoadDone: state.watermark !== null },
      });
      // `runForTenant` poe a trava antes do primeiro `await`: o GET seguinte ja mostra `running`.
      const run = runForTenant(ctx.tenantId).catch((error: unknown) => {
        logger.warn('lis_requisitions_sync.tenant_failed', {
          tenantId: ctx.tenantId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return { run };
    },

    async runScheduledTick() {
      if (tickInProgress || deps.scheduleTimes.length === 0) return;
      tickInProgress = true;
      try {
        const slot = latestDueSlot(now(), deps.scheduleTimes);
        if (slot === null) return;
        let tenants: Array<{ tenantId: string; lastRunAt: Date | null }>;
        try {
          tenants = await repo.listEnabledTenants();
        } catch (error) {
          logger.warn('lis_requisitions_sync.tick_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        for (const t of tenants) {
          if (t.lastRunAt !== null && t.lastRunAt.getTime() >= slot.getTime()) continue;
          if (running.has(t.tenantId)) continue;
          try {
            await runForTenant(t.tenantId);
          } catch (error) {
            logger.warn('lis_requisitions_sync.tenant_failed', {
              tenantId: t.tenantId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        tickInProgress = false;
      }
    },

    runForTenant,
  };
}

/** So para teste. */
export function resetLisRequisitionLocksForTest(): void {
  running.clear();
  tickInProgress = false;
}
