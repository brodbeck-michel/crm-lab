/**
 * ExamPackageService — CRMLAB-10 (Cadastro de pacotes de exames).
 *
 * Mesmas regras de `ExamCatalogService` (SERVICES.md §5), adaptadas ao pacote:
 *  - `name` unico por tenant -> `CONFLICT` (409)
 *  - desativar (`isActive:false`) em vez de deletar — nao existe `delete()`
 *  - `examIds` precisam existir e estar ATIVOS no tenant -> `VALIDATION_ERROR`
 *    com `details.fields.examIds` (mesmo padrao de `prices.<insuranceId>` do
 *    catalogo de exames)
 *  - preco por convenio com fallback nunca bloqueia (D-004): sem override em
 *    `exam_package_prices`, `effectivePrice` cai no `pricePrivate` calculado
 *  - cache 1h, invalidado em create/update/upsertPrices, SEMPRE prefixado por
 *    tenant — mesmo raciocinio do cabecalho de `exam-catalog.service.ts`
 *
 * `pricePrivate` NUNCA e lido de uma coluna: e sempre recalculado a partir dos
 * precos CORRENTES dos exames incluidos (`calculatePackagePrivatePrice`,
 * `@crm-lab/shared`) — por isso `getByIds`/`resolveActiveByIds` tambem nao
 * passam pelo cache de listagem, mesma razao de `ExamCatalogService`.
 */
import type {
  CreateExamPackageRequest,
  ExamPackage,
  ExamPackagePrice,
  ListExamPackagesQuery,
  Paginated,
  UpdateExamPackagePricesRequest,
  UpdateExamPackageRequest,
} from '@crm-lab/shared';
import type { CacheService } from '../lib/cache.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  isUniqueViolation,
  type ExamPackageRepository,
  type ExamPackageListCriteria,
  type ExamPackageSortBy,
  type SortOrder,
} from '../repositories/exam-package.repository.js';
import type { AuditService } from './audit.service.js';

export const EXAM_PACKAGE_CACHE_TTL_SECONDS = 3600;

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 10_000;
export const DEFAULT_SORT_BY: ExamPackageSortBy = 'name';
export const DEFAULT_ORDER: SortOrder = 'asc';

export type ExamPackageFilters = ListExamPackagesQuery;

export interface ExamPackageResolution {
  found: ExamPackage[];
  byId: Map<string, ExamPackage>;
  invalidIds: string[];
  missingIds: string[];
  inactiveIds: string[];
}

export function cachePrefix(tenantId: string): string {
  return `exam-packages:${tenantId}:`;
}

export function listCacheKey(tenantId: string, criteria: ExamPackageListCriteria): string {
  const parts = [
    `p${criteria.page}`,
    `l${criteria.limit}`,
    `s${criteria.sortBy}`,
    `o${criteria.order}`,
    `a${criteria.active === undefined ? '*' : String(criteria.active)}`,
    `q${criteria.search ?? '*'}`,
    `i${criteria.insuranceId ?? '*'}`,
  ];
  return `${cachePrefix(tenantId)}list:${parts.join('|')}`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function toCriteria(filters: ExamPackageFilters): ExamPackageListCriteria {
  const sortBy =
    filters.sortBy !== undefined && isSortable(filters.sortBy)
      ? (filters.sortBy as ExamPackageSortBy)
      : DEFAULT_SORT_BY;
  const search = filters.search?.trim();
  return {
    active: filters.active,
    search: search !== undefined && search.length > 0 ? search : undefined,
    insuranceId: filters.insuranceId,
    page: clampInt(filters.page, DEFAULT_PAGE, 1, MAX_PAGE),
    limit: clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    sortBy,
    order: filters.order === 'desc' ? 'desc' : DEFAULT_ORDER,
  };
}

function isSortable(value: string): boolean {
  return ['name', 'discountPercent', 'createdAt', 'updatedAt'].includes(value);
}

const MANAGER_ROLES = ['manager', 'admin'] as const;

function assertCanWrite(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

export class ExamPackageService {
  constructor(
    private readonly repository: ExamPackageRepository,
    private readonly cache: CacheService,
    private readonly audit?: AuditService,
  ) {}

  async list(tenantId: string, filters: ExamPackageFilters): Promise<Paginated<ExamPackage>> {
    const criteria = toCriteria(filters);
    const key = listCacheKey(tenantId, criteria);

    const cached = await this.cache.get<Paginated<ExamPackage>>(key);
    if (cached) return cached;

    const page = await this.repository.list(tenantId, criteria);
    const result: Paginated<ExamPackage> = {
      data: page.rows,
      pagination: {
        page: criteria.page,
        limit: criteria.limit,
        total: page.total,
        totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
      },
    };

    await this.cache.set(key, result, EXAM_PACKAGE_CACHE_TTL_SECONDS);
    return result;
  }

  async getByIds(tenantId: string, ids: string[]): Promise<ExamPackage[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await this.repository.findByIds(tenantId, unique);
    const byId = new Map(found.map((pkg) => [pkg.id, pkg]));
    return unique.map((id) => byId.get(id)).filter((pkg): pkg is ExamPackage => pkg !== undefined);
  }

  async resolveActiveByIds(
    tenantId: string,
    ids: string[],
    insuranceId?: string,
  ): Promise<ExamPackageResolution> {
    const unique = [...new Set(ids)];
    const resolution: ExamPackageResolution = {
      found: [],
      byId: new Map(),
      invalidIds: [],
      missingIds: [],
      inactiveIds: [],
    };
    if (unique.length === 0) return resolution;

    const rows = await this.repository.findByIds(tenantId, unique, insuranceId);
    const all = new Map(rows.map((pkg) => [pkg.id, pkg]));

    for (const id of unique) {
      const pkg = all.get(id);
      if (!pkg) {
        resolution.missingIds.push(id);
        resolution.invalidIds.push(id);
        continue;
      }
      if (!pkg.isActive) {
        resolution.inactiveIds.push(id);
        resolution.invalidIds.push(id);
        continue;
      }
      resolution.found.push(pkg);
      resolution.byId.set(pkg.id, pkg);
    }
    return resolution;
  }

  /** manager/admin. `name` duplicado no tenant -> CONFLICT. `examIds` precisa ter ao menos 1 exame ativo. */
  async create(ctx: TenantContext, dto: CreateExamPackageRequest): Promise<ExamPackage> {
    assertCanWrite(ctx);
    const name = dto.name.trim();

    if (await this.repository.nameExists(ctx.tenantId, name)) {
      throw conflictOnName(name);
    }

    await this.assertExamIdsActive(ctx.tenantId, dto.examIds);

    let created: ExamPackage;
    try {
      created = await this.repository.insert(ctx.tenantId, {
        name,
        discountPercent: dto.discountPercent,
        examIds: dto.examIds,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflictOnName(name);
      throw err;
    }

    await this.invalidate(ctx.tenantId);
    return created;
  }

  /**
   * manager/admin. Id de outro tenant -> `NOT_FOUND` (RLS ja escondeu a
   * linha; CLAUDE.md regra 8). `isActive:false` e o unico "delete" do
   * cadastro. `examIds`, quando enviado, substitui o conjunto inteiro
   * (semantica de PUT); omitido, preserva os exames atuais.
   */
  async update(ctx: TenantContext, id: string, dto: UpdateExamPackageRequest): Promise<ExamPackage> {
    assertCanWrite(ctx);

    if (dto.examIds !== undefined) {
      await this.assertExamIdsActive(ctx.tenantId, dto.examIds);
    }

    const updated = await this.repository.update(ctx.tenantId, id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.discountPercent !== undefined ? { discountPercent: dto.discountPercent } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.examIds !== undefined ? { examIds: dto.examIds } : {}),
    });

    if (!updated) throw notFound({ resource: 'exam_package', id });

    await this.invalidate(ctx.tenantId);
    return updated;
  }

  async listPrices(ctx: TenantContext, packageId: string): Promise<ExamPackagePrice[]> {
    await this.requirePackage(ctx.tenantId, packageId);
    return this.repository.findPrices(ctx.tenantId, packageId);
  }

  async upsertPrices(
    ctx: TenantContext,
    packageId: string,
    dto: UpdateExamPackagePricesRequest,
  ): Promise<ExamPackagePrice[]> {
    assertCanWrite(ctx);
    await this.requirePackage(ctx.tenantId, packageId);

    const fields: Record<string, string> = {};
    const seen = new Set<string>();
    for (const item of dto.prices) {
      const key = `prices.${item.insuranceId}`;
      if (seen.has(item.insuranceId)) {
        fields[key] = 'Convênio repetido no corpo';
      }
      seen.add(item.insuranceId);
    }
    for (const item of dto.prices) {
      const key = `prices.${item.insuranceId}`;
      if (key in fields) continue;
      const active = await this.repository.activeInsuranceExists(ctx.tenantId, item.insuranceId);
      if (!active) fields[key] = 'Convênio inexistente ou inativo neste laboratório';
    }
    if (Object.keys(fields).length > 0) {
      throw new BusinessError('VALIDATION_ERROR', { fields });
    }

    if (!this.audit) {
      throw new Error(
        'ExamPackageService sem AuditService nao pode escrever preco (upsertPrices)',
      );
    }

    const oldPrices = await this.repository.findPrices(ctx.tenantId, packageId);
    const updated = await this.repository.upsertPrices(ctx.tenantId, packageId, dto.prices);
    await this.invalidate(ctx.tenantId);

    await this.audit.record(ctx, {
      action: 'update_exam_package_prices',
      entityType: 'exam_package',
      entityId: packageId,
      oldValues: { prices: oldPrices },
      newValues: { prices: updated },
    });

    return updated;
  }

  /** Todo `examId` precisa existir e estar ATIVO no tenant, senao VALIDATION_ERROR. */
  private async assertExamIdsActive(tenantId: string, examIds: string[]): Promise<void> {
    const unique = [...new Set(examIds)];
    const active = await this.repository.activeExamIds(tenantId, unique);
    const invalid = unique.filter((id) => !active.has(id));
    if (invalid.length > 0) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { examIds: 'Exame inexistente ou inativo neste laboratório', invalidIds: invalid },
      });
    }
  }

  private async requirePackage(tenantId: string, packageId: string): Promise<ExamPackage> {
    const pkg = await this.repository.findById(tenantId, packageId);
    if (!pkg) throw notFound({ resource: 'exam_package', id: packageId });
    return pkg;
  }

  private async invalidate(tenantId: string): Promise<void> {
    await this.cache.delByPrefix(cachePrefix(tenantId));
  }
}

function conflictOnName(name: string): BusinessError {
  return new BusinessError('CONFLICT', { field: 'name', name });
}
