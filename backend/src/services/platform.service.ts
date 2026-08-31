/**
 * PlatformService — o console da plataforma (`/platform/*`, PAGES.md §11).
 *
 * ============================================================================
 * O QUE ESTE SERVICE PODE E O QUE NAO PODE VER
 * ============================================================================
 * Este e o unico lugar do sistema que legitimamente cruza tenants, e por isso o
 * mais perigoso. PAGES.md §11 e SECURITY.md ("Console de Plataforma") dizem a
 * mesma coisa em palavras diferentes: o operador NAO tem caminho para
 * conversas, mensagens, pacientes nem canais internos de laboratorio, e isso e
 * "requisito, nao configuracao".
 *
 * PODE (cadastro do tenant + agregado sem sujeito):
 *   - nome, slug, plano, validade da assinatura, ativo/inativo
 *   - quantidade de usuarios, quantidade de mensagens no mes, quantidade de
 *     propostas — `COUNT(*)`, numeros sem dono
 *
 * NAO PODE (e nao ha metodo que devolva):
 *   - conteudo de mensagem, nome/telefone/e-mail de paciente, titulo ou texto
 *     de conversa, canal interno do laboratorio, linha de proposta, valor de
 *     proposta, nome de usuario do laboratorio
 *
 * A duvida se resolve para o lado conservador: campo que POSSA identificar
 * pessoa ou revelar conteudo nao entra no payload, mesmo que fosse conveniente
 * para a tela. `TenantSummary` e `BillingResponse` de `@crm-lab/shared` ja
 * refletem esse recorte — nao acrescente campo sem reler esta secao.
 *
 * ============================================================================
 * `withoutTenant` — a excecao auditada
 * ============================================================================
 * Todo acesso daqui roda em `db.withoutTenant()`, ou seja, SEM `app.tenant_id`
 * e SEM RLS. E legitimo exatamente por um motivo: o console opera SOBRE
 * tenants, entao nao existe um tenant corrente que pudesse filtrar as linhas —
 * a migracao 002 e `src/db/types.ts` listam este caminho como uma das duas
 * excecoes previstas (a outra e o login). Como a rede de seguranca do banco nao
 * se aplica, a barreira e dupla e explicita: `requireRoles('platform_operator')`
 * na rota E a checagem de papel no comeco de cada metodo aqui.
 *
 * ============================================================================
 * ONBOARDING E ATOMICO
 * ============================================================================
 * `createTenant` grava tenant + tema padrao + `#geral` + `#aprovacoes` + admin
 * inicial numa transacao SO (WORKFLOWS.md §7). Um onboarding pela metade — um
 * laboratorio sem admin, ou sem canal de aprovacao — e pior que nenhum: o
 * cliente nao consegue entrar e nao ha caminho de conserto pela UI.
 */
import { randomUUID } from 'node:crypto';
import type {
  BillingResponse,
  CreateTenantRequest,
  ListTenantsQuery,
  ListTenantsResponse,
  PaginationMeta,
  SubscriptionPlan,
  TenantSummary,
  TenantUsage,
} from '@crm-lab/shared';
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { hashPassword } from '../lib/password.js';
import * as platformRepo from '../repositories/platform.repository.js';
import type { TenantSummaryEntity } from '../repositories/platform.repository.js';
import * as themeRepo from '../repositories/theme.repository.js';
import * as userRepo from '../repositories/user.repository.js';
import type { AuditService } from './audit.service.js';
import { DEFAULT_THEME, THEME_PRESETS } from './theme.service.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/**
 * Teto de `page` (Onda 7, pendencia mecanica — mesmo motivo de
 * `proposal.service.ts`). Sem ele, `?page=9007199254740991` produz um
 * `OFFSET` absurdo na consulta.
 */
export const MAX_PAGE = 10_000;
export const MIN_PASSWORD_LENGTH = 8;

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = ['starter', 'pro', 'enterprise'];

/**
 * Tabela de planos.
 *
 * PROVISORIA E DOCUMENTADA (D-019): nenhum doc do projeto define preco, franquia
 * de mensagens ou preco do excedente — `SCHEMA.md` so lista os tres nomes de
 * plano e PAGES.md §11 pede a tela. Os valores vivem AQUI, num unico lugar, em
 * vez de espalhados por queries, justamente para que trocar a tabela de precos
 * (ou move-la para o banco) seja uma edicao so.
 */
export interface PlanTerms {
  /** Mensalidade em BRL — numero, nunca string formatada. */
  monthlyPrice: number;
  /** Franquia de mensagens no mes. */
  messagesIncluded: number;
}

export const PLAN_CATALOG: Readonly<Record<SubscriptionPlan, PlanTerms>> = {
  starter: { monthlyPrice: 299, messagesIncluded: 1000 },
  pro: { monthlyPrice: 799, messagesIncluded: 5000 },
  enterprise: { monthlyPrice: 1999, messagesIncluded: 20000 },
};

/** Preco por mensagem excedente a franquia, em BRL. */
export const EXTRA_MESSAGE_PRICE = 0.1;

/** Canais internos criados no onboarding (WORKFLOWS.md §7 passo 2). */
export const DEFAULT_CHANNELS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'geral', name: '#geral' },
  { key: 'aprovacoes', name: '#aprovacoes' },
];

/**
 * Mensalidade = plano + excedente. Funcao pura e exportada para que a conta do
 * excedente seja testavel sem precisar inserir mil mensagens no banco.
 *
 * `extraMessages` e DERIVADO (uso menos franquia), nunca lido de
 * `tenants.extra_messages`: um contador materializado seria uma segunda origem
 * para o mesmo numero (BUSINESS_RULES.md §5).
 */
export function billingFor(
  plan: SubscriptionPlan,
  messagesUsed: number,
): { messagesIncluded: number; extraMessages: number; monthlyPrice: number } {
  const terms = PLAN_CATALOG[plan];
  const extraMessages = Math.max(0, messagesUsed - terms.messagesIncluded);
  return {
    messagesIncluded: terms.messagesIncluded,
    extraMessages,
    monthlyPrice: toMoney(terms.monthlyPrice + extraMessages * EXTRA_MESSAGE_PRICE),
  };
}

// `ListTenantsQuery` vive em @crm-lab/shared (platform.types.ts): o mesmo shape
// era declarado aqui e de novo na tela, contra um contrato ja documentado.
// Reexportado porque `platform.routes.ts` importa o tipo deste modulo.
export type { ListTenantsQuery };

export interface PlatformService {
  listTenants(ctx: TenantContext, query: ListTenantsQuery): Promise<ListTenantsResponse>;
  createTenant(ctx: TenantContext, dto: CreateTenantRequest): Promise<TenantSummary>;
  getBilling(ctx: TenantContext): Promise<BillingResponse>;
}

export interface PlatformServiceDeps {
  db: DbClient;
  audit: AuditService;
  /** Injetavel para fixar o mes de referencia da fatura em teste. */
  now?: () => Date;
}

/**
 * A UNICA porta do console. Papel diferente de `platform_operator` nao passa —
 * inclusive admin de laboratorio, que e admin do SEU tenant e de mais nenhum.
 */
function assertOperator(ctx: TenantContext): void {
  if (ctx.role !== 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['platform_operator'] });
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPlan(value: string): value is SubscriptionPlan {
  return (SUBSCRIPTION_PLANS as readonly string[]).includes(value);
}

function planOf(value: string): SubscriptionPlan {
  return isPlan(value) ? value : 'starter';
}

/**
 * Projecao explicita para o contrato. Escrita campo a campo de proposito: um
 * spread deixaria qualquer coluna nova do repositorio vazar para a resposta do
 * console sem ninguem perceber.
 */
function toSummary(entity: TenantSummaryEntity): TenantSummary {
  return {
    id: entity.id,
    name: entity.name,
    slug: entity.slug,
    isActive: entity.isActive,
    subscriptionPlan: planOf(entity.subscriptionPlan),
    subscriptionUntil: entity.subscriptionUntil,
    userCount: entity.userCount,
    createdAt: entity.createdAt,
  };
}

/** Primeiro instante do mes corrente e do mes seguinte, em UTC. */
export function currentMonthBounds(now: Date): { start: string; endExclusive: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const start = `${year}-${pad(month + 1)}-01 00:00:00`;
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  return { start, endExclusive: `${nextYear}-${pad(nextMonth + 1)}-01 00:00:00` };
}

/** Slug canonico: minusculo, sem espaco, so `a-z0-9-`. */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCreate(dto: CreateTenantRequest): {
  name: string;
  slug: string;
  plan: SubscriptionPlan;
  adminEmail: string;
  adminName: string;
} {
  const fields: Record<string, string> = {};

  const name = typeof dto.name === 'string' ? dto.name.trim() : '';
  if (name.length < 2) fields.name = 'Nome do laboratorio e obrigatorio';

  const slug = typeof dto.slug === 'string' ? normalizeSlug(dto.slug) : '';
  if (slug.length < 2) fields.slug = 'Slug deve ter ao menos 2 caracteres (a-z, 0-9, hifen)';

  if (typeof dto.plan !== 'string' || !isPlan(dto.plan)) {
    fields.plan = `Plano deve ser um de: ${SUBSCRIPTION_PLANS.join(', ')}`;
  }

  const adminEmail = typeof dto.adminEmail === 'string' ? dto.adminEmail.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(adminEmail)) fields.adminEmail = 'E-mail invalido';

  const adminName = typeof dto.adminName === 'string' ? dto.adminName.trim() : '';
  if (adminName.length < 2) fields.adminName = 'Nome do administrador e obrigatorio';

  if (typeof dto.adminPassword !== 'string' || dto.adminPassword.length < MIN_PASSWORD_LENGTH) {
    fields.adminPassword = `Senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }

  if (Object.keys(fields).length > 0) {
    throw new BusinessError('VALIDATION_ERROR', { fields });
  }
  return { name, slug, plan: dto.plan, adminEmail, adminName };
}

export function createPlatformService(deps: PlatformServiceDeps): PlatformService {
  const { db, audit } = deps;
  const now = deps.now ?? ((): Date => new Date());

  const listTenants = async (
    ctx: TenantContext,
    query: ListTenantsQuery,
  ): Promise<ListTenantsResponse> => {
    assertOperator(ctx);

    const search = query.search?.trim();
    const criteria = {
      page: clampInt(query.page, DEFAULT_PAGE, 1, MAX_PAGE),
      limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      ...(search !== undefined && search.length > 0 ? { search } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.plan !== undefined ? { plan: query.plan } : {}),
    };

    const { rows, total } = await db.withoutTenant(async (tx) => ({
      total: await platformRepo.countTenants(tx, criteria),
      rows: await platformRepo.listTenants(tx, criteria),
    }));

    const pagination: PaginationMeta = {
      page: criteria.page,
      limit: criteria.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / criteria.limit),
    };
    return { tenants: rows.map(toSummary), pagination };
  };

  /**
   * Onboarding completo em UMA transacao (WORKFLOWS.md §7).
   *
   * Ordem: tenant -> tema -> canais -> admin. Se qualquer passo falhar, o
   * `withoutTenant` desfaz tudo e o slug continua livre para a proxima
   * tentativa. Nada de "cria o tenant agora e o admin depois".
   */
  const createTenant = async (
    ctx: TenantContext,
    dto: CreateTenantRequest,
  ): Promise<TenantSummary> => {
    assertOperator(ctx);
    const input = validateCreate(dto);
    const passwordHash = await hashPassword(dto.adminPassword);

    const created = await db.withoutTenant(async (tx: DbTx) => {
      if (await platformRepo.slugExists(tx, input.slug)) {
        throw new BusinessError('CONFLICT', { field: 'slug', slug: input.slug });
      }

      const tenantId = await platformRepo.insertTenant(tx, {
        name: input.name,
        slug: input.slug,
        plan: input.plan,
      });

      // Tema padrao do design system: Terracota & Salvia (WORKFLOWS.md §7).
      await themeRepo.upsert(tx, tenantId, {
        ...DEFAULT_THEME,
        name: THEME_PRESETS[0]?.name ?? 'Terracota & Sálvia',
        brandName: input.name,
      });

      for (const channel of DEFAULT_CHANNELS) {
        await platformRepo.insertChannel(tx, tenantId, channel.key, channel.name);
      }

      await userRepo.insert(tx, {
        id: randomUUID(),
        tenantId,
        email: input.adminEmail,
        passwordHash,
        name: input.adminName,
        role: 'admin',
        discountLimit: DEFAULT_DISCOUNT_LIMIT.admin,
      });

      const summary = await platformRepo.findTenantById(tx, tenantId);
      if (!summary) throw new Error('Tenant recem-criado nao foi encontrado na mesma transacao');
      return summary;
    });

    // Acao de operador sobre tenant: auditada (src/db/types.ts, BUSINESS_RULES §9).
    // Sem senha e sem e-mail no payload do log — o log tambem e dado exposto.
    await audit.record(ctx, {
      action: 'create_tenant',
      entityType: 'tenant',
      entityId: created.id,
      newValues: { name: created.name, slug: created.slug, plan: created.subscriptionPlan },
    });

    return toSummary(created);
  };

  const getBilling = async (ctx: TenantContext): Promise<BillingResponse> => {
    assertOperator(ctx);
    const month = currentMonthBounds(now());

    const rows = await db.withoutTenant((tx) => platformRepo.billingUsage(tx, month));

    const usage: TenantUsage[] = rows.map((row) => {
      const plan = planOf(row.plan);
      const billing = billingFor(plan, row.messagesUsed);
      return {
        tenantId: row.tenantId,
        tenantName: row.tenantName,
        plan,
        messagesIncluded: billing.messagesIncluded,
        messagesUsed: row.messagesUsed,
        extraMessages: billing.extraMessages,
        proposalCount: row.proposalCount,
        monthlyPrice: billing.monthlyPrice,
      };
    });

    // MRR conta so tenant ativo: laboratorio suspenso nao fatura.
    const active = rows.filter((row) => row.isActive).map((row) => row.tenantId);
    const activeSet = new Set(active);
    const mrr = usage
      .filter((row) => activeSet.has(row.tenantId))
      .reduce((total, row) => total + row.monthlyPrice, 0);

    return {
      usage,
      totals: {
        mrr: toMoney(mrr),
        tenants: activeSet.size,
        messages: usage.reduce((total, row) => total + row.messagesUsed, 0),
      },
    };
  };

  return { listTenants, createTenant, getBilling };
}
