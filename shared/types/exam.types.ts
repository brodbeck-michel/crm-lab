import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

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
}

export interface ListExamsQuery extends PaginationQuery {
  active?: boolean;
  category?: string;
  search?: string;
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
}
