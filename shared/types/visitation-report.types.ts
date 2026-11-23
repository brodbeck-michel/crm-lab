/**
 * Relatório de Visitação — API_CONTRACTS.md §14b (CRMLAB-193, D-333).
 * Fórmulas em BUSINESS_RULES.md §15b.
 *
 *   GET /api/v1/visitation-reports/summary        indicadores, por representante, por finalidade, evolução
 *   GET /api/v1/visitation-reports/stale-doctors  médicos sem visita realizada há mais de X dias
 *
 * Representante, gestor e admin (a atendente recebe 403). O representante vê só o
 * escopo dele (carteira + visitas em que é o responsável) — o servidor recorta e
 * IGNORA o `responsibleId` que ele mandar.
 */
import type { IsoDate, IsoDateTime } from './api.types.js';
import type { DoctorAbcClass } from './doctor.types.js';
import type { VisitPurposeColor } from './visit-purpose.types.js';

/** Período máximo de uma consulta, em dias (inclusive as duas pontas). */
export const VISITATION_REPORT_MAX_PERIOD_DAYS = 366;

/** Granularidade da série de evolução. */
export const VISITATION_REPORT_GRANULARITIES = ['week', 'month'] as const;
export type VisitationReportGranularity = (typeof VISITATION_REPORT_GRANULARITIES)[number];

/** Sem `granularity`: semana até este tamanho de período (dias), mês acima. */
export const VISITATION_REPORT_WEEKLY_MAX_DAYS = 92;

/** "Sem visita há mais de X dias": padrão, mínimo e máximo de X. */
export const VISITATION_REPORT_STALE_DEFAULT_DAYS = 60;
export const VISITATION_REPORT_STALE_MIN_DAYS = 1;
export const VISITATION_REPORT_STALE_MAX_DAYS = 730;

/** Teto de linhas da lista de esquecidos (`truncated` avisa quando cortou). */
export const VISITATION_REPORT_STALE_MAX_ROWS = 1000;

/** `GET /visitation-reports/summary`. Datas de calendário (dia local de São Paulo). */
export interface VisitationReportQuery {
  from: IsoDate;
  to: IsoDate;
  /** Só gestor/admin; o representante tem o filtro ignorado. */
  responsibleId?: string;
  purposeId?: string;
  abcClass?: DoctorAbcClass;
  /** Ausente: `week` até 92 dias de período, `month` acima. */
  granularity?: VisitationReportGranularity;
}

/** Cobertura: médicos ativos da carteira e quantos tiveram visita realizada no período. */
export interface VisitationReportCoverage {
  portfolioDoctors: number;
  visitedDoctors: number;
  /** % com uma casa (0–100); `null` quando a carteira está vazia. */
  rate: number | null;
}

/** Cobertura por classe ABC. `unclassified` = médico ainda sem classe calculada (D-333 item 6). */
export interface VisitationReportCoverageByClass {
  A: VisitationReportCoverage;
  B: VisitationReportCoverage;
  C: VisitationReportCoverage;
  unclassified: VisitationReportCoverage;
}

export interface VisitationReportSummary {
  /** Visitas do período ainda `agendada` (não encerradas). */
  scheduled: number;
  completed: number;
  cancelled: number;
  notReceived: number;
  /** Soma dos quatro status. */
  total: number;
  /** Reagendamentos feitos no período (eventos do histórico de datas). */
  reschedules: number;
  /** realizadas ÷ (realizadas + canceladas + não recebidas), em % com uma casa; `null` sem encerradas. */
  completionRate: number | null;
  /** Média de (check-out − check-in) das realizadas com os dois, em minutos (uma casa); `null` sem amostra. */
  averageDurationMinutes: number | null;
  /** Quantas visitas entraram na média de duração. */
  durationSampleSize: number;
  coverage: VisitationReportCoverage;
}

/** Uma linha da tabela "Por representante". */
export interface VisitationReportRepresentativeRow {
  responsible: { id: string; name: string };
  /** Médicos ATIVOS da carteira (respeita o filtro de classe ABC). */
  portfolioDoctors: number;
  /** Desses, quantos tiveram visita realizada no período (por qualquer responsável). */
  visitedDoctors: number;
  coverage: VisitationReportCoverage;
  coverageByClass: VisitationReportCoverageByClass;
  /** Visitas em que ELE é o responsável, por status, no período. */
  completed: number;
  cancelled: number;
  notReceived: number;
  /** Reagendamentos no período de visitas em que ele é o responsável. */
  reschedules: number;
}

export interface VisitationReportPurposeRow {
  purpose: { id: string; name: string; color: VisitPurposeColor };
  /** Todas as visitas do período com esta finalidade (qualquer status). */
  total: number;
  completed: number;
}

/** Um ponto da evolução. `bucket` = 1º dia da semana (segunda) ou do mês. */
export interface VisitationReportEvolutionPoint {
  bucket: IsoDate;
  total: number;
  completed: number;
  cancelled: number;
  notReceived: number;
}

export interface VisitationReport {
  period: { from: IsoDate; to: IsoDate };
  granularity: VisitationReportGranularity;
  /** `all` = gestor/admin (laboratório inteiro ou o representante filtrado); `own` = representante. */
  scope: 'all' | 'own';
  summary: VisitationReportSummary;
  byRepresentative: VisitationReportRepresentativeRow[];
  byPurpose: VisitationReportPurposeRow[];
  evolution: VisitationReportEvolutionPoint[];
}

/** `GET /visitation-reports/stale-doctors`. */
export interface VisitationReportStaleQuery {
  /** X: 1–730, padrão 60. */
  days?: number;
  responsibleId?: string;
  abcClass?: DoctorAbcClass;
}

export interface VisitationReportStaleDoctor {
  id: string;
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialty: string | null;
  abcClass: DoctorAbcClass | null;
  responsible: { id: string; name: string } | null;
  /** Última visita realizada (o check-out dela); `null` = nunca visitado. */
  lastVisitAt: IsoDateTime | null;
  /** Dias de calendário (São Paulo) desde a última visita; `null` = nunca visitado. */
  daysSinceLastVisit: number | null;
}

export interface VisitationReportStaleResponse {
  days: number;
  /** "Hoje" em São Paulo — a base da contagem de dias. */
  referenceDate: IsoDate;
  doctors: VisitationReportStaleDoctor[];
  /** Total antes do teto de linhas. */
  total: number;
  truncated: boolean;
}
