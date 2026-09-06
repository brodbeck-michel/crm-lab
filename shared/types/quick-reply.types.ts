/**
 * Respostas rápidas ("macros") do Composer. Onda 8 §3.
 * Espelha docs/api/API_CONTRACTS.md §9 e docs/database/SCHEMA.md §22.
 *
 * `shortcut` é o que se digita DEPOIS da `/` — a barra nunca é gravada.
 */
import type { IsoDateTime } from './api.types.js';

export interface QuickReply {
  id: string;
  /** Sem a barra, `^[a-z0-9-]{2,32}$`. Único no tenant. */
  shortcut: string;
  title: string;
  content: string;
  /** `null` quando quem criou já não existe (`ON DELETE SET NULL`). */
  createdBy: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * Sem `pagination`: a lista alimenta o menu do Composer, que precisa dela
 * inteira para filtrar enquanto se digita (exceção explícita ao D-070, §9).
 */
export interface ListQuickRepliesResponse {
  quickReplies: QuickReply[];
}

export interface CreateQuickReplyRequest {
  shortcut: string;
  title: string;
  content: string;
}

export interface UpdateQuickReplyRequest {
  shortcut?: string;
  title?: string;
  content?: string;
}

/**
 * Formato do atalho — fonte única do regex, espelhando o CHECK da migração 008.
 * Backend valida no Zod, frontend usa para o hint do formulário: um só lugar.
 */
export const QUICK_REPLY_SHORTCUT_PATTERN = /^[a-z0-9-]{2,32}$/;

export const QUICK_REPLY_TITLE_MAX = 120;
export const QUICK_REPLY_CONTENT_MAX = 2000;

/** `trim` + caixa baixa. NÃO remove acento nem espaço — ver SERVICES.md §17. */
export function normalizeShortcut(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidShortcut(raw: string): boolean {
  return QUICK_REPLY_SHORTCUT_PATTERN.test(normalizeShortcut(raw));
}
