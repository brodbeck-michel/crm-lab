import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

/** Origem do cadastro do exame. Onda 7: só existe e é exibida — a sincronização LIS
 * (dono de quem vence numa edição concorrente) fica para onda futura, pós-resposta Bitlab. */
export type ExamSource = 'manual' | 'lis';

export interface Exam {
  id: string;
  name: string;
  code: string;
  description: string | null;
  preparation: string | null;
  turnaroundHours: number | null;
  pricePrivate: number;
  priceInsurance: number;
  category: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Código TUSS (tabela 22 TISS/ANS), 8 dígitos. `null` = não confirmado — nunca inventado (D-081). */
  tussCode: string | null;
  /** Código AMB legado, para o de-para do faturamento. `null` = não confirmado. */
  ambCode: string | null;
  /** Ex.: "Sangue — tubo tampa roxa (EDTA)". */
  material: string | null;
  source: ExamSource;
  /** Nomes alternativos para busca (`exam_synonyms`, SCHEMA.md §20). */
  synonyms: string[];
  /** Presente SÓ quando `?insuranceId=` é passado em `GET /exams`. */
  effectivePrice?: number;
  /** Idem — de onde `effectivePrice` veio. */
  priceSource?: 'insurance' | 'private';
}

export interface ListExamsQuery extends PaginationQuery {
  active?: boolean;
  category?: string;
  search?: string;
  /** Acrescenta `effectivePrice`/`priceSource` a cada item (aditivo, backward compatible). */
  insuranceId?: string;
}

export interface ListExamsResponse {
  exams: Exam[];
  pagination: PaginationMeta;
}

export interface CreateExamRequest {
  name: string;
  code: string;
  description?: string | null;
  preparation?: string | null;
  turnaroundHours?: number | null;
  pricePrivate: number;
  priceInsurance: number;
  category?: string | null;
  tussCode?: string | null;
  ambCode?: string | null;
  material?: string | null;
  /** Substitui o conjunto de sinônimos (semântica de PUT sobre a coleção filha). */
  synonyms?: string[];
}

export interface UpdateExamRequest {
  name?: string;
  description?: string | null;
  preparation?: string | null;
  turnaroundHours?: number | null;
  pricePrivate?: number;
  priceInsurance?: number;
  category?: string | null;
  isActive?: boolean;
  tussCode?: string | null;
  ambCode?: string | null;
  material?: string | null;
  /** Enviar `synonyms` no PATCH substitui o conjunto inteiro (semântica de PUT). */
  synonyms?: string[];
}
