/**
 * LisImportService — SERVICES.md §19 (Onda 9 — D-109). Dono de `lis_imports` e
 * `lis_budgets` (SCHEMA.md §25/§26).
 */
import type {
  ImportLisSpreadsheetRequest,
  LisImport,
  ListLisImportsQuery,
  ListLisImportsResponse,
  PurgeLisBudgetsRequest,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { CacheService } from '../lib/cache.js';
import type { WsHub } from '../lib/ws-hub.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  consolidateLisRows,
  LisSpreadsheetError,
  parseLisSpreadsheet,
  type LisSpreadsheetRow,
} from '../lib/lis-spreadsheet.js';
import {
  countReconciledBudgets,
  LisImportRepository,
  purgeBudgets,
  resolveAttendantId,
  resolveInsuranceId,
  upsertBudget,
} from '../repositories/lis-import.repository.js';
import type { AuditService } from './audit.service.js';
import { announceLisWins, reconcileBudgets } from './lis-reconcile.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;

/** Teto explicito (API_CONTRACTS.md §10.1) — defesa em profundidade, nao restricao real esperada. */
export const LIS_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** Linhas por transacao (SERVICES.md §19: "upsert em chunks, dentro de uma transacao por chunk"). */
export const CHUNK_SIZE = 200;

const MANAGER_ROLES = ['manager', 'admin'] as const;
const ADMIN_ROLE = ['admin'] as const;

const CACHE_PREFIX = (tenantId: string): string => `lis:${tenantId}:`;

/** De onde vem o lote: planilha (com nome do arquivo) ou API do Bitlab (D-185 item 3). */
export type LisIngestSource = { kind: 'import'; fileName: string } | { kind: 'sync' };

export interface LisIngestInput {
  tenantId: string;
  /** Quem disparou. `null` = agendador da sincronizacao. */
  createdBy: string | null;
}

export interface LisImportService {
  import(ctx: TenantContext, dto: ImportLisSpreadsheetRequest): Promise<LisImport>;
  /**
   * Trecho comum a planilha e API (SERVICES.md §19): consolida, resolve
   * atendente/convenio, upsert em chunks e fecha o `lis_imports`. Sem alcada —
   * quem chama ja validou. Sem audit — `import` audita a planilha, e a
   * sincronizacao audita so o "Sincronizar agora".
   */
  ingestRows(input: LisIngestInput, rows: LisSpreadsheetRow[], source: LisIngestSource): Promise<LisImport>;
  purge(ctx: TenantContext, dto: PurgeLisBudgetsRequest): Promise<LisImport>;
  list(ctx: TenantContext, query: ListLisImportsQuery): Promise<ListLisImportsResponse>;
  getLatest(ctx: TenantContext): Promise<LisImport | null>;
}

export interface LisImportServiceDeps {
  db: DbClient;
  cache: CacheService;
  audit: AuditService;
  /** WS `proposal.status_changed` das propostas que a conciliacao levou a `ganho` (D-119). */
  wsHub: WsHub;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function assertManagerOrAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

function assertAdmin(ctx: TenantContext): void {
  if (ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...ADMIN_ROLE] });
  }
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createLisImportService(deps: LisImportServiceDeps): LisImportService {
  const repository = new LisImportRepository(deps.db);
  const { db, cache, audit, wsHub } = deps;

  async function ingestRows(
    input: LisIngestInput,
    rows: LisSpreadsheetRow[],
    source: LisIngestSource,
  ): Promise<LisImport> {
    const { tenantId } = input;
    const rowsInFile = rows.length;
    const validRows = rows.filter((row) => row.number.trim() !== '');
    const consolidated = consolidateLisRows(validRows);

    const created = await repository.insertProcessing(tenantId, {
      kind: source.kind,
      fileName: source.kind === 'import' ? source.fileName : null,
      rowsInFile,
      createdBy: input.createdBy,
    });

    let actualAccepted = 0;
    let errorMessage: string | null = null;
    const won: string[] = [];

    const chunks = chunk(consolidated, CHUNK_SIZE);
    for (const batch of chunks) {
      try {
        const wonInChunk = await db.withTenant(tenantId, async (tx) => {
          for (const row of batch) {
            const insuranceId = await resolveInsuranceId(tx, tenantId, row);
            const attendantId = await resolveAttendantId(tx, tenantId, row);
            await upsertBudget(tx, tenantId, created.id, row, insuranceId, attendantId);
          }
          // Conciliacao por chunk, na mesma transacao (D-119 item 3b).
          return reconcileBudgets(
            tx,
            tenantId,
            batch.map((row) => row.number.trim()),
          );
        });
        actualAccepted += batch.length;
        won.push(...wonInChunk);
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    const failed = errorMessage !== null;
    const finished = await repository.finish(tenantId, created.id, {
      status: failed ? 'failed' : 'completed',
      rowsAccepted: actualAccepted,
      rowsRejected: rowsInFile - actualAccepted,
      errorMessage,
      proposalsWon: won.length,
    });

    await cache.delByPrefix(CACHE_PREFIX(tenantId));
    await announceLisWins({ wsHub, cache }, tenantId, won);
    return finished;
  }

  return {
    ingestRows,

    async import(ctx: TenantContext, dto: ImportLisSpreadsheetRequest): Promise<LisImport> {
      assertManagerOrAdmin(ctx);

      const buffer = decodeBase64(dto.contentBase64);
      if (buffer.byteLength === 0 || buffer.byteLength > LIS_IMPORT_MAX_BYTES) {
        throw new BusinessError('MEDIA_TOO_LARGE', {
          byteSize: buffer.byteLength,
          max: LIS_IMPORT_MAX_BYTES,
        });
      }

      // Erro de arquivo e recusado ANTES de qualquer escrita (API_CONTRACTS.md §10.1).
      let rawRows: LisSpreadsheetRow[];
      try {
        rawRows = await parseLisSpreadsheet(buffer);
      } catch (err) {
        if (err instanceof LisSpreadsheetError) {
          throw new BusinessError('VALIDATION_ERROR', { reason: err.reason });
        }
        throw err;
      }

      const finished = await ingestRows(
        { tenantId: ctx.tenantId, createdBy: ctx.userId },
        rawRows,
        { kind: 'import', fileName: dto.fileName },
      );

      await audit.record(ctx, {
        action: 'import_lis_spreadsheet',
        entityType: 'lis_import',
        entityId: finished.id,
        newValues: {
          fileName: finished.fileName,
          rowsInFile: finished.rowsInFile,
          rowsAccepted: finished.rowsAccepted,
          rowsRejected: finished.rowsRejected,
          status: finished.status,
        },
      });

      return finished;
    },

    async purge(ctx: TenantContext, dto: PurgeLisBudgetsRequest): Promise<LisImport> {
      assertAdmin(ctx);
      if (dto.confirm !== 'LIMPAR') {
        throw new BusinessError('VALIDATION_ERROR', {
          fields: { confirm: 'precisa ser exatamente "LIMPAR"' },
        });
      }

      // Limpar apagaria o lado B de propostas ja conciliadas (D-119 item 8).
      await db.withTenant(ctx.tenantId, async (tx) => {
        const linkedCount = await countReconciledBudgets(tx, ctx.tenantId);
        if (linkedCount > 0) {
          throw new BusinessError('CONFLICT', { reason: 'lis_budgets_reconciled', linkedCount });
        }
        await purgeBudgets(tx, ctx.tenantId);
      });
      const created = await repository.insertPurge(ctx.tenantId, ctx.userId);

      await cache.delByPrefix(CACHE_PREFIX(ctx.tenantId));

      await audit.record(ctx, {
        action: 'purge_lis_budgets',
        entityType: 'lis_import',
        entityId: created.id,
      });

      return created;
    },

    async list(ctx: TenantContext, query: ListLisImportsQuery): Promise<ListLisImportsResponse> {
      assertManagerOrAdmin(ctx);
      const criteria = {
        page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
        limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      };
      const page = await repository.list(ctx.tenantId, criteria);
      return {
        imports: page.rows,
        pagination: {
          page: criteria.page,
          limit: criteria.limit,
          total: page.total,
          totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
        },
      };
    },

    async getLatest(ctx: TenantContext): Promise<LisImport | null> {
      assertManagerOrAdmin(ctx);
      return repository.getLatest(ctx.tenantId);
    },
  };
}
