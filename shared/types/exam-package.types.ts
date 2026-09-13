/**
 * Pacotes de exames (combos) — CRMLAB-10. Aba "Pacotes" dentro do Cadastro de
 * Exames (`/catalog`, D-129). Espelha docs/api/API_CONTRACTS.md §4b e
 * docs/database/SCHEMA.md §28-30.
 *
 * NÃO é o modo "Pacotes" da tela de Novo Orçamento (`/budget/new`) — aquele é
 * outro card (bug CRMLAB-13, backlog separado). Este arquivo é só o
 * CADASTRO/CRUD de pacotes.
 *
 * Mesmo padrão de `exam.types.ts`/`insurance.types.ts`:
 *  - ativo/inativo em vez de DELETE (D-004: histórico referencia o pacote)
 *  - preço por convênio com fallback nunca bloqueia (`effectivePrice`/
 *    `priceSource`, mesmo mecanismo de `exam_prices`)
 *
 * A diferença central para `Exam`: o preço particular do pacote NUNCA é um
 * valor digitado — é sempre `calculatePackagePrivatePrice(items, discountPercent)`,
 * calculado a partir dos preços CORRENTES dos exames incluídos. Backend e
 * frontend chamam a MESMA função (um número, uma origem, igual a
 * `calculateTotal` em `proposal.types.ts`).
 */
import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

/** Um exame incluído no pacote, com o preço particular CORRENTE do catálogo. */
export interface ExamPackageItem {
  examId: string;
  examName: string;
  examCode: string;
  /** Preço particular atual do exame (`exam_catalog.price_private`) — usado no cálculo do pacote. */
  pricePrivate: number;
}

export interface ExamPackage {
  id: string;
  name: string;
  /** 0 a 100. */
  discountPercent: number;
  items: ExamPackageItem[];
  /**
   * Soma de `items[].pricePrivate` menos `discountPercent`% — SEMPRE
   * calculado (`calculatePackagePrivatePrice`), nunca digitado à mão.
   */
  pricePrivate: number;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Presente SÓ quando `?insuranceId=` é passado em `GET /exam-packages`. */
  effectivePrice?: number;
  /** Idem — de onde `effectivePrice` veio. */
  priceSource?: 'insurance' | 'private';
}

export interface ListExamPackagesQuery extends PaginationQuery {
  active?: boolean;
  search?: string;
  /** Acrescenta `effectivePrice`/`priceSource` a cada item (aditivo, backward compatible). */
  insuranceId?: string;
}

export interface ListExamPackagesResponse {
  packages: ExamPackage[];
  pagination: PaginationMeta;
}

export interface CreateExamPackageRequest {
  name: string;
  /** Ids de `exam_catalog`, precisam existir e estar ATIVOS no tenant. Mínimo 1. */
  examIds: string[];
  discountPercent: number;
}

export interface UpdateExamPackageRequest {
  name?: string;
  /** Presente ⇒ substitui o conjunto inteiro de exames incluídos (semântica de PUT). */
  examIds?: string[];
  discountPercent?: number;
  isActive?: boolean;
}

/** Uma linha de `GET /exam-packages/:id/prices` — preço do pacote para um convênio. */
export interface ExamPackagePrice {
  insuranceId: string;
  price: number;
}

/** Corpo de `PUT /exam-packages/:id/prices` — upsert em lote (semântica de PUT: estado completo). */
export interface UpdateExamPackagePricesRequest {
  prices: Array<{ insuranceId: string; price: number }>;
}

export interface ListExamPackagePricesResponse {
  prices: ExamPackagePrice[];
}

/**
 * Cálculo canônico do preço particular do pacote. BUSINESS_RULES.md §1
 * (mesmo espírito de `calculateTotal`/`calculateSubtotal` em `proposal.types.ts`):
 * soma em CENTAVOS primeiro, desconto aplicado depois, para não acumular erro
 * de ponto flutuante.
 */
export function calculatePackagePrivatePrice(
  items: Array<{ pricePrivate: number }>,
  discountPercent: number,
): number {
  const subtotalCents = items.reduce((sum, item) => sum + Math.round(item.pricePrivate * 100), 0);
  const totalCents = Math.round(subtotalCents * (1 - discountPercent / 100));
  return totalCents / 100;
}
