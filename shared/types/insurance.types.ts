/**
 * Convênios do laboratório e preço por (exame, convênio). Onda 7 — D-081/D-082.
 * Espelha docs/api/API_CONTRACTS.md §8 e docs/database/SCHEMA.md §18-§19.
 *
 * "Particular" NÃO é uma linha desta tabela: é a AUSÊNCIA de convênio
 * (`insurance_id NULL` em `proposals`). Ver D-082.
 */
import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

export type InsuranceType =
  | 'cooperativa'
  | 'medicina_grupo'
  | 'seguradora'
  | 'autogestao'
  | 'especial';

export interface Insurance {
  id: string;
  name: string;
  officialName: string | null;
  ansCode: string | null;
  type: InsuranceType;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ListInsurancesQuery extends PaginationQuery {
  active?: boolean;
  search?: string;
}

export interface ListInsurancesResponse {
  insurances: Insurance[];
  pagination: PaginationMeta;
}

export interface CreateInsuranceRequest {
  name: string;
  officialName?: string;
  ansCode?: string;
  type: InsuranceType;
}

export interface UpdateInsuranceRequest {
  name?: string;
  officialName?: string | null;
  ansCode?: string | null;
  type?: InsuranceType;
  isActive?: boolean;
}

/** Uma linha de `GET /exams/:id/prices` — preço do exame para um convênio. */
export interface ExamPrice {
  insuranceId: string;
  price: number;
}

/** Corpo de `PUT /exams/:id/prices` — upsert em lote (semântica de PUT: estado completo). */
export interface UpdateExamPricesRequest {
  prices: Array<{ insuranceId: string; price: number }>;
}

export interface ListExamPricesResponse {
  prices: ExamPrice[];
}
