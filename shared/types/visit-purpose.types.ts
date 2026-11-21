/**
 * Finalidade da visita — CRMLAB-190 (D-330), épico CRMLAB-187. Espelha
 * docs/api/API_CONTRACTS.md §14 ("Finalidades da visita") e
 * docs/database/SCHEMA.md §36a.
 *
 * Cadastro por laboratório (para quê a visita acontece), separado do `type`
 * da visita (modo: como). A cor é a CHAVE de uma paleta fixa de tokens
 * (`--color-purpose-<chave>-*`, DESIGN_TOKENS.md) — nunca hex.
 */
import type { IsoDateTime } from './api.types.js';

/** Paleta fechada, na ordem do seletor de cor. */
export const VISIT_PURPOSE_COLORS = [
  'azul',
  'verde',
  'agua',
  'violeta',
  'ambar',
  'rosa',
  'terracota',
  'cinza',
] as const;
export type VisitPurposeColor = (typeof VISIT_PURPOSE_COLORS)[number];

export const VISIT_PURPOSE_COLOR_LABELS: Record<VisitPurposeColor, string> = {
  azul: 'Azul',
  verde: 'Verde',
  agua: 'Verde-água',
  violeta: 'Violeta',
  ambar: 'Âmbar',
  rosa: 'Rosa',
  terracota: 'Terracota',
  cinza: 'Cinza',
};

export function isVisitPurposeColor(value: string): value is VisitPurposeColor {
  return (VISIT_PURPOSE_COLORS as readonly string[]).includes(value);
}

/** Tamanho máximo do nome da finalidade. */
export const VISIT_PURPOSE_NAME_MAX_LENGTH = 60;

/**
 * As finalidades com que todo laboratório nasce (semente da migração 073 e
 * do trigger em `tenants`). Aqui só como referência para seeds/testes: quem
 * grava é o banco.
 */
export const DEFAULT_VISIT_PURPOSES: ReadonlyArray<{ name: string; color: VisitPurposeColor }> = [
  { name: 'Visita', color: 'azul' },
  { name: 'Solicitação de patrocínio', color: 'verde' },
  { name: 'Solicitação de material', color: 'agua' },
  { name: 'Acesso a exames', color: 'violeta' },
  { name: 'Compromisso interno', color: 'cinza' },
];

/** O que a visita carrega da finalidade (agenda, detalhe, linha do tempo). */
export interface VisitPurposeRef {
  id: string;
  name: string;
  color: VisitPurposeColor;
}

export interface VisitPurpose extends VisitPurposeRef {
  isActive: boolean;
  sortOrder: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** `GET /settings/visit-purposes` — todas (ativas e inativas), por `sortOrder` e nome. */
export interface ListVisitPurposesResponse {
  purposes: VisitPurpose[];
}

/** `POST /settings/visit-purposes` — nasce ativa, no fim da ordem. */
export interface CreateVisitPurposeRequest {
  name: string;
  color: VisitPurposeColor;
}

/** `PATCH /settings/visit-purposes/:id` — parcial. */
export interface UpdateVisitPurposeRequest {
  name?: string;
  color?: VisitPurposeColor;
  isActive?: boolean;
  sortOrder?: number;
}
