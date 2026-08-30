/**
 * ExamCatalogService — SERVICES.md §5.
 *
 * Regras implementadas aqui:
 *  - `code` unico por tenant -> `CONFLICT` (409), nunca erro de constraint cru
 *  - desativar (`isActive:false`) em vez de deletar: propostas historicas
 *    referenciam o exame (D-004). Nao existe `delete()` — de proposito.
 *  - cache 1h (D-011 escolhe Redis ou memoria pela env var), invalidado em
 *    create/update/upsertPrices, SEMPRE prefixado por tenant.
 *
 * ---------------------------------------------------------------------------
 * CACHE — por que a chave comeca pelo tenant
 * ---------------------------------------------------------------------------
 * `exams:<tenantId>:list:<filtros>`. O tenantId e o PRIMEIRO segmento por dois
 * motivos: (1) uma listagem de A nunca pode ser servida a B — cache que vaza e
 * falha de isolamento tanto quanto uma query sem `WHERE tenant_id`;
 * (2) invalidar vira `delByPrefix('exams:<tenantId>:')`, que derruba todas as
 * combinacoes de filtro daquele tenant e de mais nenhum. Onda 7: a chave
 * incorpora `insuranceId` — filtro diferente, preco diferente, cache diferente.
 *
 * ---------------------------------------------------------------------------
 * getByIds / resolveActiveByIds NAO passam pelo cache
 * ---------------------------------------------------------------------------
 * O ProposalService le o preco ATUAL do catalogo por aqui (BUSINESS_RULES §1,
 * WORKFLOWS §2 passo 5) e ignora qualquer preco vindo do cliente. Servir esse
 * caminho de um cache seria arriscar precificar uma proposta com valor velho.
 * Custo: uma query indexada por PK. Beneficio: impossivel gravar preco obsoleto.
 * Vale tambem para o preco por convenio (Onda 7): `resolveActiveByIds(...,
 * insuranceId)` nao le `exams:<tenantId>:` pelo mesmo motivo.
 */
import type {
  CreateExamRequest,
  Exam,
  ExamPrice,
  ListExamsQuery,
  Paginated,
  UpdateExamPricesRequest,
  UpdateExamRequest,
} from '@crm-lab/shared';
import type { CacheService } from '../lib/cache.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  isUniqueViolation,
  type ExamRepository,
  type ExamListCriteria,
  type ExamSortBy,
  type SortOrder,
} from '../repositories/exam.repository.js';
import type { AuditService } from './audit.service.js';

/** TTL do catalogo: 1 hora (SERVICES.md §5). */
export const EXAM_CACHE_TTL_SECONDS = 3600;

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_SORT_BY: ExamSortBy = 'name';
export const DEFAULT_ORDER: SortOrder = 'asc';

export type ExamFilters = ListExamsQuery;

/**
 * Resultado de `resolveActiveByIds` — o que o ProposalService consome.
 *
 * `invalidIds` ja vem pronto para `details.examIds` de
 * `EXAM_NOT_FOUND_OR_INACTIVE` (API_ERRORS.md, secao Propostas):
 *
 *   const resolution = await examCatalog.resolveActiveByIds(tenantId, ids);
 *   if (resolution.invalidIds.length > 0) {
 *     throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', {
 *       examIds: resolution.invalidIds,
 *     });
 *   }
 *   // resolution.found tem os precos ATUAIS, na ordem dos ids pedidos
 */
export interface ExamResolution {
  /** Exames ativos encontrados, na ordem em que os ids foram pedidos. */
  found: Exam[];
  /** Ativos encontrados, indexados por id — evita `find()` no chamador. */
  byId: Map<string, Exam>;
  /** `missingIds` + `inactiveIds`, sem repeticao e na ordem pedida. */
  invalidIds: string[];
  /** Ids que nao existem neste tenant (ou pertencem a outro). */
  missingIds: string[];
  /** Ids que existem no tenant mas estao com `isActive:false`. */
  inactiveIds: string[];
}

/** Chave de cache de listagem — SEMPRE prefixada pelo tenant. */
export function cachePrefix(tenantId: string): string {
  return `exams:${tenantId}:`;
}

export function listCacheKey(tenantId: string, criteria: ExamListCriteria): string {
  const parts = [
    `p${criteria.page}`,
    `l${criteria.limit}`,
    `s${criteria.sortBy}`,
    `o${criteria.order}`,
    `a${criteria.active === undefined ? '*' : String(criteria.active)}`,
    `c${criteria.category ?? '*'}`,
    `q${criteria.search ?? '*'}`,
    `i${criteria.insuranceId ?? '*'}`,
  ];
  return `${cachePrefix(tenantId)}list:${parts.join('|')}`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Normaliza a query string para uma chave de cache estavel e um SQL previsivel. */
export function toCriteria(filters: ExamFilters): ExamListCriteria {
  const sortBy =
    filters.sortBy !== undefined && isSortable(filters.sortBy)
      ? (filters.sortBy as ExamSortBy)
      : DEFAULT_SORT_BY;
  const search = filters.search?.trim();
  const category = filters.category?.trim();
  return {
    active: filters.active,
    category: category !== undefined && category.length > 0 ? category : undefined,
    search: search !== undefined && search.length > 0 ? search : undefined,
    insuranceId: filters.insuranceId,
    page: clampInt(filters.page, DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER),
    limit: clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    sortBy,
    order: filters.order === 'desc' ? 'desc' : DEFAULT_ORDER,
  };
}

function isSortable(value: string): boolean {
  return [
    'name',
    'code',
    'category',
    'pricePrivate',
    'priceInsurance',
    'createdAt',
    'updatedAt',
  ].includes(value);
}

const MANAGER_ROLES = ['manager', 'admin'] as const;

/** "A UI esconde, o servidor recusa" — a rota ja barra, o service confere de novo. */
function assertCanWrite(ctx: TenantContext): void {
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...MANAGER_ROLES] });
  }
}

export class ExamCatalogService {
  /**
   * `audit` e opcional de proposito: o ProposalService (Task 4) instancia este
   * service so para `getByIds`/`resolveActiveByIds`/`list` — caminhos que
   * nunca escrevem preco e por isso nunca precisam de auditoria. Exigir o
   * parametro quebraria a compilacao de todo consumidor que so le o catalogo.
   * So `upsertPrices` (dono da escrita auditada) depende dele.
   */
  constructor(
    private readonly repository: ExamRepository,
    private readonly cache: CacheService,
    private readonly audit?: AuditService,
  ) {}

  /** Listagem paginada e cacheada (1h). Envelope nomeado fica na rota (D-009). */
  async list(tenantId: string, filters: ExamFilters): Promise<Paginated<Exam>> {
    const criteria = toCriteria(filters);
    const key = listCacheKey(tenantId, criteria);

    const cached = await this.cache.get<Paginated<Exam>>(key);
    if (cached) return cached;

    const page = await this.repository.list(tenantId, criteria);
    const result: Paginated<Exam> = {
      data: page.rows,
      pagination: {
        page: criteria.page,
        limit: criteria.limit,
        total: page.total,
        totalPages: page.total === 0 ? 0 : Math.ceil(page.total / criteria.limit),
      },
    };

    await this.cache.set(key, result, EXAM_CACHE_TTL_SECONDS);
    return result;
  }

  /**
   * Assinatura de SERVICES.md §5. Devolve os exames encontrados no tenant,
   * ATIVOS E INATIVOS, e IGNORA ids desconhecidos (nao lanca).
   *
   * Inclui inativos de proposito: uma proposta historica referencia exames que
   * ja sairam do catalogo e ainda precisa exibi-los. Quem esta MONTANDO uma
   * proposta nova quer o outro metodo, `resolveActiveByIds`, que separa o que
   * nao serve.
   *
   * Nunca le do cache de listagem — ver o cabecalho do arquivo.
   */
  async getByIds(tenantId: string, ids: string[]): Promise<Exam[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const found = await this.repository.findByIds(tenantId, unique);
    const byId = new Map(found.map((exam) => [exam.id, exam]));
    // Mantem a ordem pedida; ids desconhecidos simplesmente nao aparecem.
    return unique.map((id) => byId.get(id)).filter((exam): exam is Exam => exam !== undefined);
  }

  /**
   * Versao estruturada de `getByIds` para quem PRECISA saber o que falhou —
   * hoje o ProposalService (EXAM_NOT_FOUND_OR_INACTIVE com `details.examIds`).
   *
   * Diferenca para `getByIds`: `found` traz SOMENTE ativos, e todo id que nao
   * existe ou esta inativo aparece em `invalidIds`.
   *
   * Onda 7: `insuranceId` opcional acrescenta `effectivePrice`/`priceSource`
   * a cada exame de `found`/`byId`, com o mesmo fallback de `list`. Continua
   * sem ler cache — preco de convenio nao pode sair obsoleto, mesma razao do
   * preco particular.
   */
  async resolveActiveByIds(
    tenantId: string,
    ids: string[],
    insuranceId?: string,
  ): Promise<ExamResolution> {
    const unique = [...new Set(ids)];
    const resolution: ExamResolution = {
      found: [],
      byId: new Map(),
      invalidIds: [],
      missingIds: [],
      inactiveIds: [],
    };
    if (unique.length === 0) return resolution;

    const rows = await this.repository.findByIds(tenantId, unique, insuranceId);
    const all = new Map(rows.map((exam) => [exam.id, exam]));

    for (const id of unique) {
      const exam = all.get(id);
      if (!exam) {
        resolution.missingIds.push(id);
        resolution.invalidIds.push(id);
        continue;
      }
      if (!exam.isActive) {
        resolution.inactiveIds.push(id);
        resolution.invalidIds.push(id);
        continue;
      }
      resolution.found.push(exam);
      resolution.byId.set(exam.id, exam);
    }
    return resolution;
  }

  /** manager/admin. `code` duplicado no tenant -> CONFLICT. */
  async create(ctx: TenantContext, dto: CreateExamRequest): Promise<Exam> {
    assertCanWrite(ctx);
    const code = dto.code.trim();
    const name = dto.name.trim();

    if (await this.repository.codeExists(ctx.tenantId, code)) {
      throw conflictOnCode(code);
    }

    let created: Exam;
    try {
      created = await this.repository.insert(ctx.tenantId, {
        name,
        code,
        description: dto.description ?? null,
        preparation: dto.preparation ?? null,
        turnaroundHours: dto.turnaroundHours ?? null,
        pricePrivate: dto.pricePrivate,
        priceInsurance: dto.priceInsurance,
        category: dto.category ?? null,
        tussCode: dto.tussCode ?? null,
        ambCode: dto.ambCode ?? null,
        material: dto.material ?? null,
        synonyms: dto.synonyms ?? [],
      });
    } catch (err) {
      // Corrida entre o SELECT acima e o INSERT: o indice unico decide.
      if (isUniqueViolation(err)) throw conflictOnCode(code);
      throw err;
    }

    await this.invalidate(ctx.tenantId);
    return created;
  }

  /**
   * manager/admin. Id de outro tenant -> `NOT_FOUND` (o RLS ja escondeu a
   * linha; vazar `FORBIDDEN` confirmaria a existencia — CLAUDE.md regra 8).
   *
   * `isActive:false` e o unico "delete" do catalogo. `synonyms`, quando
   * enviado, substitui o conjunto inteiro (semantica de PUT); omitido,
   * preserva os sinonimos atuais.
   */
  async update(ctx: TenantContext, id: string, dto: UpdateExamRequest): Promise<Exam> {
    assertCanWrite(ctx);

    const updated = await this.repository.update(ctx.tenantId, id, {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.preparation !== undefined ? { preparation: dto.preparation } : {}),
      ...(dto.turnaroundHours !== undefined ? { turnaroundHours: dto.turnaroundHours } : {}),
      ...(dto.pricePrivate !== undefined ? { pricePrivate: dto.pricePrivate } : {}),
      ...(dto.priceInsurance !== undefined ? { priceInsurance: dto.priceInsurance } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.tussCode !== undefined ? { tussCode: dto.tussCode } : {}),
      ...(dto.ambCode !== undefined ? { ambCode: dto.ambCode } : {}),
      ...(dto.material !== undefined ? { material: dto.material } : {}),
      ...(dto.synonyms !== undefined ? { synonyms: dto.synonyms } : {}),
    });

    if (!updated) throw notFound({ resource: 'exam', id });

    await this.invalidate(ctx.tenantId);
    return updated;
  }

  /** Onda 7. Uma linha por convenio COM preco cadastrado. Qualquer papel do tenant. */
  async listPrices(ctx: TenantContext, examId: string): Promise<ExamPrice[]> {
    await this.requireExam(ctx.tenantId, examId);
    return this.repository.findPrices(ctx.tenantId, examId);
  }

  /**
   * Onda 7. Upsert em lote — semantica de PUT (estado completo): linha
   * ausente do corpo e removida. manager/admin. Cada `insuranceId` do corpo
   * precisa existir e estar ATIVO no tenant, senao `VALIDATION_ERROR`
   * (`details.fields["prices.<insuranceId>"]`) — nao vaza se o convenio
   * existe em outro tenant, so que ele "nao serve" para este upsert.
   * `insuranceId` repetido no array tambem e `VALIDATION_ERROR`.
   *
   * Exame de outro tenant -> `NOT_FOUND` (recurso PRINCIPAL da rota; CLAUDE.md
   * regra 8), verificado ANTES da validacao do corpo.
   */
  async upsertPrices(
    ctx: TenantContext,
    examId: string,
    dto: UpdateExamPricesRequest,
  ): Promise<ExamPrice[]> {
    assertCanWrite(ctx);
    await this.requireExam(ctx.tenantId, examId);

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
      if (key in fields) continue; // ja marcado como duplicado
      const active = await this.repository.activeInsuranceExists(ctx.tenantId, item.insuranceId);
      if (!active) fields[key] = 'Convênio inexistente ou inativo neste laboratório';
    }
    if (Object.keys(fields).length > 0) {
      throw new BusinessError('VALIDATION_ERROR', { fields });
    }

    const oldPrices = await this.repository.findPrices(ctx.tenantId, examId);
    const updated = await this.repository.upsertPrices(ctx.tenantId, examId, dto.prices);
    await this.invalidate(ctx.tenantId);

    await this.audit?.record(ctx, {
      action: 'update_exam_prices',
      entityType: 'exam',
      entityId: examId,
      oldValues: { prices: oldPrices },
      newValues: { prices: updated },
    });

    return updated;
  }

  /** Exame inexistente OU de outro tenant -> `NOT_FOUND` (nunca `FORBIDDEN`). */
  private async requireExam(tenantId: string, examId: string): Promise<Exam> {
    const exam = await this.repository.findById(tenantId, examId);
    if (!exam) throw notFound({ resource: 'exam', id: examId });
    return exam;
  }

  /** Derruba TODAS as listagens cacheadas deste tenant — e so deste tenant. */
  private async invalidate(tenantId: string): Promise<void> {
    await this.cache.delByPrefix(cachePrefix(tenantId));
  }
}

function conflictOnCode(code: string): BusinessError {
  return new BusinessError('CONFLICT', { field: 'code', code });
}
