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
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import {
  consolidateLisRows,
  LisSpreadsheetError,
  parseLisSpreadsheet,
  type LisSpreadsheetRow,
} from '../lib/lis-spreadsheet.js';
import {
  LisImportRepository,
  purgeBudgets,
  resolveAttendantId,
  resolveInsuranceId,
  upsertBudget,
} from '../repositories/lis-import.repository.js';
import type { AuditService } from './audit.service.js';

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

export interface LisImportService {
  import(ctx: TenantContext, dto: ImportLisSpreadsheetRequest): Promise<LisImport>;
  purge(ctx: TenantContext, dto: PurgeLisBudgetsRequest): Promise<LisImport>;
  list(ctx: TenantContext, query: ListLisImportsQuery): Promise<ListLisImportsResponse>;
  getLatest(ctx: TenantContext): Promise<LisImport | null>;
}

export interface LisImportServiceDeps {
  db: DbClient;
  cache: CacheService;
  audit: AuditService;
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
  const { db, cache, audit } = deps;

  return {
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

      const rowsInFile = rawRows.length;
      const validRows = rawRows.filter((row) => row.number.trim() !== '');
      const consolidated = consolidateLisRows(validRows);

      const created = await repository.insertProcessing(ctx.tenantId, {
        kind: 'import',
        fileName: dto.fileName,
        rowsInFile,
        createdBy: ctx.userId,
      });

      let actualAccepted = 0;
      let errorMessage: string | null = null;

      const chunks = chunk(consolidated, CHUNK_SIZE);
      for (const batch of chunks) {
        try {
          await db.withTenant(ctx.tenantId, async (tx) => {
            for (const row of batch) {
              const insuranceId = await resolveInsuranceId(tx, ctx.tenantId, row);
              const attendantId = await resolveAttendantId(tx, ctx.tenantId, row);
              await upsertBudget(tx, ctx.tenantId, created.id, row, insuranceId, attendantId);
            }
          });
          actualAccepted += batch.length;
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
          break;
        }
      }

      const failed = errorMessage !== null;
      const finished = await repository.finish(ctx.tenantId, created.id, {
        status: failed ? 'failed' : 'completed',
        rowsAccepted: actualAccepted,
        rowsRejected: rowsInFile - actualAccepted,
        errorMessage,
      });

      await cache.delByPrefix(CACHE_PREFIX(ctx.tenantId));

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

      await db.withTenant(ctx.tenantId, (tx) => purgeBudgets(tx, ctx.tenantId));
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
