/**
 * FunnelRulesService — SERVICES.md §26 (CRMLAB-56, D-190..D-194). Dono de
 * `funnel_rules` (SCHEMA.md §32).
 *
 * `readFunnelRules(tx, tenantId)` e o PONTO UNICO DE LEITURA das regras para o
 * resto do backend (ProposalService hoje; CRMLAB-57..60 depois): roda na
 * transacao de quem chama e devolve sempre o objeto completo, com os padroes
 * aplicados chave por chave.
 */
import {
  DAY_COUNTINGS,
  DEFAULT_FUNNEL_RULES,
  REENGAGEMENT_MESSAGE_MAX,
  RULE_ACTOR_ROLES,
  SEND_MESSAGE_TEMPLATE_MAX,
  findUnknownTemplateVariables,
  type FunnelRules,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { findStoredRules, upsertRules } from '../repositories/funnel-rules.repository.js';
import type { AuditService } from './audit.service.js';

const TENANT_ROLES = ['attendant', 'manager', 'admin'] as const;
const WRITE_ROLES = ['manager', 'admin'] as const;

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function lastKey(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? '';
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Erro de uma folha (valor final), ou `null` se ela vale. O tipo esperado vem
 * da folha correspondente em `DEFAULT_FUNNEL_RULES`; faixas e enums, do caminho.
 * Usado na escrita (PATCH) e na leitura (JSON gravado que nao vale cai no padrao).
 */
function leafError(path: string, template: unknown, value: unknown): string | null {
  if (typeof template === 'boolean') {
    return typeof value === 'boolean' ? null : 'Deve ser verdadeiro ou falso';
  }
  if (typeof template === 'number') {
    const key = lastKey(path);
    if (key === 'days')
      return isIntIn(value, 1, 365) ? null : 'Informe um número inteiro de 1 a 365';
    if (key === 'hours')
      return isIntIn(value, 1, 720) ? null : 'Informe um número inteiro de 1 a 720';
    return 'Campo desconhecido';
  }
  if (Array.isArray(template)) {
    if (
      !Array.isArray(value) ||
      !value.every((item) => (RULE_ACTOR_ROLES as readonly unknown[]).includes(item)) ||
      new Set(value).size !== value.length
    ) {
      return 'Perfis válidos: attendant, manager (sem repetir)';
    }
    return null;
  }
  if (path === 'automation.dayCounting') {
    return (DAY_COUNTINGS as readonly unknown[]).includes(value)
      ? null
      : 'Use "calendar" (dias corridos) ou "business" (dias úteis)';
  }
  if (path === 'sendMessage.template') {
    if (typeof value !== 'string') return 'Deve ser um texto';
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > SEND_MESSAGE_TEMPLATE_MAX) {
      return `O modelo deve ter de 1 a ${SEND_MESSAGE_TEMPLATE_MAX} caracteres`;
    }
    const unknown = findUnknownTemplateVariables(trimmed);
    if (unknown.length > 0) {
      return `Variável desconhecida: ${unknown.map((name) => `{${name}}`).join(', ')}`;
    }
    return null;
  }
  if (path === 'reengagement.first.message' || path === 'reengagement.second.message') {
    if (typeof value !== 'string') return 'Deve ser um texto';
    const length = value.trim().length;
    if (length === 0 || length > REENGAGEMENT_MESSAGE_MAX) {
      return `A mensagem deve ter de 1 a ${REENGAGEMENT_MESSAGE_MAX} caracteres`;
    }
    return null;
  }
  return 'Campo desconhecido';
}

/** Sobrepoe `stored` aos padroes, chave por chave; o que nao vale fica com o padrao. */
function mergeStored(template: unknown, stored: unknown, path: string): unknown {
  if (isPlainObject(template)) {
    const source = isPlainObject(stored) ? stored : {};
    const out: Json = {};
    for (const key of Object.keys(template)) {
      out[key] = mergeStored(template[key], source[key], joinPath(path, key));
    }
    return out;
  }
  if (stored === undefined || leafError(path, template, stored) !== null) {
    return Array.isArray(template) ? [...template] : template;
  }
  return Array.isArray(stored) ? [...stored] : stored;
}

export function mergeWithDefaults(stored: unknown): FunnelRules {
  return mergeStored(DEFAULT_FUNNEL_RULES, stored, '') as FunnelRules;
}

/** PONTO UNICO DE LEITURA (D-190 item 2). Dentro da transacao de quem chama. */
export async function readFunnelRules(tx: DbTx, tenantId: string): Promise<FunnelRules> {
  return mergeWithDefaults(await findStoredRules(tx, tenantId));
}

export const funnelRules = { get: readFunnelRules };

/** Confere o patch contra o shape dos padroes e aplica sobre `current`. */
function applyPatch(
  template: unknown,
  current: unknown,
  patch: unknown,
  path: string,
  errors: Record<string, string>,
): unknown {
  if (isPlainObject(template)) {
    if (!isPlainObject(patch)) {
      errors[path === '' ? '_root' : path] = 'Deve ser um objeto';
      return current;
    }
    const out: Json = { ...(current as Json) };
    for (const key of Object.keys(patch)) {
      const childPath = joinPath(path, key);
      if (!(key in template)) {
        errors[childPath] = 'Campo desconhecido';
        continue;
      }
      out[key] = applyPatch(template[key], (current as Json)[key], patch[key], childPath, errors);
    }
    return out;
  }
  const error = leafError(path, template, patch);
  if (error !== null) {
    errors[path] = error;
    return current;
  }
  if (typeof patch === 'string') return patch.trim();
  return Array.isArray(patch) ? [...patch] : patch;
}

export interface FunnelRulesService {
  /** Todo perfil de laboratorio. Padroes quando nao ha linha. */
  get(ctx: TenantContext): Promise<FunnelRules>;
  /** manager/admin. Patch parcial em qualquer nivel. */
  update(ctx: TenantContext, dto: UpdateFunnelRulesRequest): Promise<FunnelRules>;
}

export interface FunnelRulesServiceDeps {
  db: DbClient;
  audit: AuditService;
}

export function createFunnelRulesService(deps: FunnelRulesServiceDeps): FunnelRulesService {
  const { db, audit } = deps;

  const get = async (ctx: TenantContext): Promise<FunnelRules> => {
    if (!(TENANT_ROLES as readonly string[]).includes(ctx.role)) {
      throw new BusinessError('FORBIDDEN', { requiredRoles: [...TENANT_ROLES] });
    }
    return db.withTenant(ctx.tenantId, (tx) => readFunnelRules(tx, ctx.tenantId));
  };

  const update = async (
    ctx: TenantContext,
    dto: UpdateFunnelRulesRequest,
  ): Promise<FunnelRules> => {
    if (!(WRITE_ROLES as readonly string[]).includes(ctx.role)) {
      throw new BusinessError('FORBIDDEN', { requiredRoles: [...WRITE_ROLES] });
    }
    const raw: unknown = dto;
    if (isPlainObject(raw) && Object.keys(raw).length === 0) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { _root: 'Envie ao menos um campo para atualizar' },
      });
    }

    const saved = await db.withTenant(ctx.tenantId, async (tx) => {
      const previous = await readFunnelRules(tx, ctx.tenantId);
      const errors: Record<string, string> = {};
      const next = applyPatch(DEFAULT_FUNNEL_RULES, previous, raw, '', errors) as FunnelRules;
      if (Object.keys(errors).length === 0 && !next.origin.fromBitlab && !next.origin.manualInCrm) {
        errors.origin = 'Deixe ao menos uma origem de proposta ligada';
      }
      // D-211 item 4: o 2º conta a partir do envio do 1º.
      if (
        Object.keys(errors).length === 0 &&
        next.reengagement.second.enabled &&
        !next.reengagement.first.enabled
      ) {
        errors['reengagement.second.enabled'] = 'Ligue o 1º reingajamento antes do 2º';
      }
      if (Object.keys(errors).length > 0) {
        throw new BusinessError('VALIDATION_ERROR', { fields: errors });
      }
      const changed = JSON.stringify(previous) !== JSON.stringify(next);
      if (changed) await upsertRules(tx, ctx.tenantId, next, ctx.userId);
      return { previous, next, changed };
    });

    if (saved.changed) {
      await audit.record(ctx, {
        action: 'update_funnel_rules',
        entityType: 'funnel_rules',
        entityId: ctx.tenantId,
        oldValues: { ...saved.previous },
        newValues: { ...saved.next },
      });
    }
    return saved.next;
  };

  return { get, update };
}
