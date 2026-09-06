/**
 * QuickReplyService — SERVICES.md §17 (Onda 8 §3).
 *
 * Dono da tabela `quick_replies`: as respostas rapidas que a atendente dispara
 * digitando `/atalho` no Composer.
 *
 * SEM `assertCanWrite`, e isso e deliberado (SERVICES.md §17): a permissao e
 * `TENANT_ROLES`, a mesma lista que `requireAuth() + denyPlatformOperator()` na
 * rota ja deixa passar. Uma checagem aqui nao recusaria ninguem que a rota nao
 * tivesse recusado antes — seria codigo que nenhum teste consegue exercitar.
 *
 * Atalho duplicado e `VALIDATION_ERROR` com o campo, NAO `CONFLICT`: o que a
 * pessoa precisa corrigir e um campo do formulario, e o frontend usa
 * `details.fields.shortcut` para marcar o input certo.
 */
import type {
  CreateQuickReplyRequest,
  ListQuickRepliesResponse,
  QuickReply,
  UpdateQuickReplyRequest,
} from '@crm-lab/shared';
import { isValidShortcut, normalizeShortcut } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import {
  QuickReplyRepository,
  isCheckViolation,
  isUniqueViolation,
} from '../repositories/quick-reply.repository.js';
import type { AuditService } from './audit.service.js';

export interface QuickReplyService {
  list(ctx: TenantContext): Promise<ListQuickRepliesResponse>;
  create(ctx: TenantContext, dto: CreateQuickReplyRequest): Promise<QuickReply>;
  update(ctx: TenantContext, id: string, dto: UpdateQuickReplyRequest): Promise<QuickReply>;
  remove(ctx: TenantContext, id: string): Promise<void>;
}

export interface QuickReplyServiceDeps {
  db: DbClient;
  audit: AuditService;
}

/** Mesmo shape de `details.fields` que o error-handler produz para o zod. */
function invalidShortcut(reason: 'format' | 'duplicate'): BusinessError {
  return new BusinessError('VALIDATION_ERROR', {
    fields: {
      shortcut:
        reason === 'duplicate'
          ? 'Já existe uma resposta rápida com este atalho'
          : 'Use apenas letras minúsculas, números e hífen (2 a 32 caracteres)',
    },
  });
}

/**
 * `trim` + caixa baixa e o limite da normalizacao (SERVICES.md §17): quem digita
 * `Coleta` quis dizer `coleta`. O que ela NAO faz e remover acento ou espaco —
 * adivinhar `/horariocoleta` a partir de "horário coleta" produziria uma macro
 * que a pessoa nao sabe chamar. Aí e erro de campo, e ela escolhe.
 */
function prepareShortcut(raw: string): string {
  const shortcut = normalizeShortcut(raw);
  if (!isValidShortcut(shortcut)) throw invalidShortcut('format');
  return shortcut;
}

export function createQuickReplyService(deps: QuickReplyServiceDeps): QuickReplyService {
  const repository = new QuickReplyRepository(deps.db);
  const audit = deps.audit;

  /**
   * Traduz a recusa do banco para o erro de campo. A corrida entre o SELECT e
   * o INSERT quem decide e o indice unico: sem isto, duas atendentes criando
   * `/coleta` ao mesmo tempo receberiam um DATABASE_ERROR 500.
   */
  function rethrowAsFieldError(err: unknown): never {
    if (isUniqueViolation(err)) throw invalidShortcut('duplicate');
    if (isCheckViolation(err)) throw invalidShortcut('format');
    throw err;
  }

  return {
    async list(ctx: TenantContext): Promise<ListQuickRepliesResponse> {
      return { quickReplies: await repository.list(ctx.tenantId) };
    },

    async create(ctx: TenantContext, dto: CreateQuickReplyRequest): Promise<QuickReply> {
      const shortcut = prepareShortcut(dto.shortcut);

      let created: QuickReply;
      try {
        created = await repository.insert(ctx.tenantId, {
          shortcut,
          title: dto.title.trim(),
          content: dto.content,
          createdBy: ctx.userId,
        });
      } catch (err) {
        rethrowAsFieldError(err);
      }

      await audit.record(ctx, {
        action: 'create_quick_reply',
        entityType: 'quick_reply',
        entityId: created.id,
        newValues: {
          shortcut: created.shortcut,
          title: created.title,
          content: created.content,
        },
      });

      return created;
    },

    /** Id inexistente ou de outro tenant -> `NOT_FOUND` (CLAUDE.md regra 8). */
    async update(
      ctx: TenantContext,
      id: string,
      dto: UpdateQuickReplyRequest,
    ): Promise<QuickReply> {
      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'quick_reply', id });

      const patch = {
        ...(dto.shortcut !== undefined ? { shortcut: prepareShortcut(dto.shortcut) } : {}),
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
      };

      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        const previous = (current as unknown as Record<string, unknown>)[key];
        if (previous !== value) {
          oldValues[key] = previous;
          newValues[key] = value;
        }
      }

      let updated: QuickReply | null;
      try {
        updated = await repository.update(ctx.tenantId, id, patch);
      } catch (err) {
        rethrowAsFieldError(err);
      }
      if (!updated) throw notFound({ resource: 'quick_reply', id });

      if (Object.keys(newValues).length > 0) {
        await audit.record(ctx, {
          action: 'update_quick_reply',
          entityType: 'quick_reply',
          entityId: id,
          oldValues,
          newValues,
        });
      }

      return updated;
    },

    /**
     * `DELETE` de verdade — macro nao e referenciada por proposta nem por
     * historico. O conteudo apagado vai para o audit log: e o que torna a
     * exclusao reversivel por uma pessoa, ja que a linha nao fica.
     */
    async remove(ctx: TenantContext, id: string): Promise<void> {
      const current = await repository.findById(ctx.tenantId, id);
      if (!current) throw notFound({ resource: 'quick_reply', id });

      const removed = await repository.remove(ctx.tenantId, id);
      if (!removed) throw notFound({ resource: 'quick_reply', id });

      await audit.record(ctx, {
        action: 'delete_quick_reply',
        entityType: 'quick_reply',
        entityId: id,
        oldValues: {
          shortcut: current.shortcut,
          title: current.title,
          content: current.content,
        },
      });
    },
  };
}
