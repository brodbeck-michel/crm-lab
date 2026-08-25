/**
 * PatientService — SERVICES.md §12 (Onda 6, D-059..D-063).
 *
 * Dono da tabela `patients` e da coluna `conversations.patient_id`.
 *
 * ============================================================================
 * DUAS CAMADAS DE RECORTE, NAO UMA
 * ============================================================================
 * O RLS (`db.withTenant`) resolve o isolamento ENTRE laboratorios. Quem, DENTRO
 * do laboratorio, enxerga qual paciente e regra de negocio e mora aqui (D-060):
 *
 *   atendente  -> pacientes com AO MENOS UMA conversa dele ou na fila livre
 *   gestor/adm -> todos os pacientes do laboratorio
 *
 * Paciente fora da visibilidade responde `NOT_FOUND`, nunca `FORBIDDEN`: 403
 * confirmaria que aquele id existe (CLAUDE.md regra 8).
 *
 * O recorte NAO para na porta da ficha: `conversationCount`, `proposalCount`,
 * `lastInteractionAt` e as entradas da timeline usam o MESMO filtro. Sem isso a
 * ficha seria um caminho lateral para o atendente ler a conversa de outro
 * atendente — dois usuarios verem numeros diferentes na mesma ficha e o
 * comportamento correto.
 *
 * ============================================================================
 * OS DOIS CAMINHOS DE LGPD
 * ============================================================================
 * `exportData` (D-062) e o UNICO metodo que ignora o recorte por papel — e por
 * isso e `admin`: exportacao filtrada pela visibilidade de quem clicou seria
 * uma resposta INCOMPLETA a um pedido de titular, pior do que negar. A defesa e
 * papel + auditoria.
 *
 * `anonymize` (D-063) roda tudo em UMA transacao e e idempotente. Escreve nas
 * colunas denormalizadas de `conversations` — a unica escrita deste service
 * fora da sua tabela, excecao de ownership registrada em SERVICES.md §12:
 * enquanto essas colunas existirem elas sao copia da IDENTIDADE do paciente, e
 * o dono da identidade e este service. Nao passa pelo ConversationService
 * porque a escrita precisa estar na mesma transacao da anonimizacao.
 */
import type {
  AnonymizePatientRequest,
  AnonymizePatientResponse,
  ListPatientTimelineQuery,
  ListPatientTimelineResponse,
  ListPatientsQuery,
  ListPatientsResponse,
  PaginationMeta,
  PatientDetail,
  PatientExport,
  UpdatePatientRequest,
} from '@crm-lab/shared';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  isPatientSortBy,
  type PatientListCriteria,
  type PatientRepository,
  type PatientSortBy,
  type PatientTimelineCriteria,
  type PatientUpdate,
  type PatientVisibility,
  type SortOrder,
} from '../repositories/patient.repository.js';
import type { AuditService } from './audit.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 100;

/**
 * Teto de `page`. Sem ele, `?page=9007199254740991&limit=100` faz o `COUNT(*)`
 * completo e um scan com OFFSET absurdo — trabalho caro no banco por um
 * parametro de query. Com o teto de `limit` em 100, 10.000 paginas cobrem
 * 1.000.000 de linhas: muito alem de qualquer navegacao real, e o excedente e
 * grampeado (nao e erro) para seguir a mesma convencao do resto do clamp.
 */
export const MAX_PAGE = 10_000;

export const DEFAULT_SORT_BY: PatientSortBy = 'lastInteractionAt';
export const DEFAULT_ORDER: SortOrder = 'desc';

function isSupervisor(ctx: TenantContext): boolean {
  return ctx.role === 'manager' || ctx.role === 'admin';
}

/** Papel -> recorte. `null` = ve tudo do laboratorio. */
export function visibilityOf(ctx: TenantContext): PatientVisibility {
  return { visibleTo: isSupervisor(ctx) ? null : ctx.userId };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(Number(value))) return fallback;
  return Math.min(Math.max(Math.trunc(Number(value)), min), max);
}

function paginationOf(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) };
}

export interface PatientServiceDeps {
  patients: PatientRepository;
  audit: AuditService;
}

export class PatientService {
  private readonly repository: PatientRepository;
  private readonly audit: AuditService;

  constructor(deps: PatientServiceDeps) {
    this.repository = deps.patients;
    this.audit = deps.audit;
  }

  async list(ctx: TenantContext, filters: ListPatientsQuery = {}): Promise<ListPatientsResponse> {
    const criteria = this.toListCriteria(ctx, filters);
    const page = await this.repository.list(ctx.tenantId, criteria);
    return {
      patients: page.rows,
      pagination: paginationOf(criteria.page, criteria.limit, page.total),
    };
  }

  /** Inexistente, de outro tenant OU fora da visibilidade => o MESMO 404. */
  async getById(ctx: TenantContext, id: string): Promise<PatientDetail> {
    const patient = await this.repository.findDetail(ctx.tenantId, id, visibilityOf(ctx));
    if (!patient) throw notFound({ resource: 'patient', id });
    return patient;
  }

  /**
   * PATCH parcial. Qualquer papel de laboratorio que ENXERGUE o paciente edita
   * (a ficha e a tela de trabalho do atendente).
   *
   * Nao toca nas colunas denormalizadas de `conversations` (D-059): elas sao o
   * registro do que o canal informou; a ficha e o cadastro.
   */
  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdatePatientRequest,
  ): Promise<PatientDetail> {
    const current = await this.getById(ctx, id);
    if (current.anonymizedAt !== null) {
      // Reabrir o cadastro apagado desfaria a anonimizacao (D-063).
      throw new BusinessError('CONFLICT', { reason: 'patient_anonymized' });
    }

    const patch: PatientUpdate = {};
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};

    for (const key of Object.keys(dto) as Array<keyof UpdatePatientRequest>) {
      const next = dto[key];
      if (next === undefined) continue;
      const previous = current[key];
      // Auditoria so dos campos que MUDARAM (contrato de §2c).
      if (!sameValue(previous, next)) {
        oldValues[key] = previous;
        newValues[key] = next;
      }
      assignPatch(patch, key, next);
    }

    const updated = await this.repository.update(ctx.tenantId, id, patch, visibilityOf(ctx));
    if (!updated) throw notFound({ resource: 'patient', id });

    if (Object.keys(newValues).length > 0) {
      await this.audit.record(ctx, {
        action: 'update_patient',
        entityType: 'patient',
        entityId: id,
        oldValues,
        newValues,
      });
    }
    return updated;
  }

  async timeline(
    ctx: TenantContext,
    id: string,
    query: ListPatientTimelineQuery = {},
  ): Promise<ListPatientTimelineResponse> {
    // 404 antes de qualquer leitura de historico: sem isso a timeline seria um
    // oraculo de existencia para paciente que o solicitante nao enxerga.
    await this.getById(ctx, id);

    const criteria: PatientTimelineCriteria = {
      ...visibilityOf(ctx),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
      limit: clampInt(query.limit, DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT),
      order: query.order === 'asc' ? 'asc' : DEFAULT_ORDER,
    };
    const page = await this.repository.timeline(ctx.tenantId, id, criteria);
    return {
      entries: page.entries,
      pagination: paginationOf(criteria.page, criteria.limit, page.total),
    };
  }

  /**
   * Dump do titular (D-062). `admin` — a checagem vive aqui tambem, nao so no
   * `requireRoles` da rota ("a UI esconde, o servidor recusa").
   *
   * SEM recorte por papel de proposito, e por isso mesmo auditado.
   */
  async exportData(ctx: TenantContext, id: string): Promise<PatientExport> {
    this.assertAdmin(ctx);
    const patient = await this.repository.findAnyById(ctx.tenantId, id);
    if (!patient) throw notFound({ resource: 'patient', id });

    const dump = await this.repository.exportData(ctx.tenantId, patient);
    // SECURITY.md exige registro da exportacao — ela junta num arquivo so tudo
    // que o laboratorio tem sobre a pessoa.
    await this.audit.record(ctx, {
      action: 'export_patient_data',
      entityType: 'patient',
      entityId: id,
      newValues: {
        conversations: dump.conversations.length,
        proposals: dump.proposals.length,
      },
    });
    return dump;
  }

  /**
   * Apagamento a pedido do titular (D-063). NAO deleta linha: anonimiza.
   *
   * Idempotente: repetir devolve 200 com o mesmo estado e
   * `conversationsAffected: 0`. Repetir o pedido do titular nao e conflito, e
   * um erro aqui empurraria o operador a procurar outro caminho.
   */
  async anonymize(
    ctx: TenantContext,
    id: string,
    dto: AnonymizePatientRequest,
  ): Promise<AnonymizePatientResponse> {
    this.assertAdmin(ctx);
    const existing = await this.repository.findAnyById(ctx.tenantId, id);
    if (!existing) throw notFound({ resource: 'patient', id });

    const result = await this.repository.anonymize(ctx.tenantId, id);
    if (!result) throw notFound({ resource: 'patient', id });

    if (result.changed) {
      // SO o motivo. Gravar os valores antigos seria desfazer a anonimizacao
      // em outra tabela (D-063).
      await this.audit.record(ctx, {
        action: 'anonymize_patient',
        entityType: 'patient',
        entityId: id,
        newValues: { reason: dto.reason },
      });
    }

    return {
      patient: result.patient,
      conversationsAffected: result.conversationsAffected,
    };
  }

  // -------------------------------------------------------------------------
  // internos
  // -------------------------------------------------------------------------

  private assertAdmin(ctx: TenantContext): void {
    if (ctx.role !== 'admin') {
      throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
    }
  }

  private toListCriteria(ctx: TenantContext, filters: ListPatientsQuery): PatientListCriteria {
    const sortBy =
      filters.sortBy !== undefined && isPatientSortBy(filters.sortBy)
        ? filters.sortBy
        : DEFAULT_SORT_BY;
    const search = filters.search?.trim();
    return {
      ...visibilityOf(ctx),
      ...(search !== undefined && search.length > 0 ? { search } : {}),
      page: clampInt(filters.page, DEFAULT_PAGE, 1, MAX_PAGE),
      limit: clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      sortBy,
      order: filters.order === 'asc' ? 'asc' : DEFAULT_ORDER,
    };
  }
}

/** Comparacao estrutural rasa — `tags`/`customFields` sao array/objeto. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => left[key] === right[key]);
  }
  return false;
}

/** Copia um campo do DTO para o patch preservando o tipo de cada chave. */
function assignPatch(
  patch: PatientUpdate,
  key: keyof UpdatePatientRequest,
  value: NonNullable<UpdatePatientRequest[keyof UpdatePatientRequest]> | null,
): void {
  switch (key) {
    case 'tags':
      if (Array.isArray(value)) patch.tags = value as string[];
      break;
    case 'customFields':
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        patch.customFields = value as Record<string, string>;
      }
      break;
    default:
      patch[key] = typeof value === 'string' || value === null ? value : null;
  }
}
