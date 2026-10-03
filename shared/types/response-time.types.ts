/**
 * Relatório de tempo de resposta (CRMLAB-83, D-257). Espelha
 * docs/api/API_CONTRACTS.md §5 (`GET /analytics/response-time`).
 *
 * BLOCO = mensagens seguidas do paciente. A espera começa na PRIMEIRA mensagem
 * do bloco e termina na próxima resposta HUMANA (`sender_type = 'agent'` com
 * `automation` nulo, do CRM ou do celular) — o mesmo início de espera do
 * `awaitingReplySince` (D-254). Automática e de sistema não respondem. O
 * encerramento do atendimento fecha o bloco SEM resposta.
 *
 * Os minutos são ÚTEIS: só o expediente de `tenant_settings.business_hours`,
 * sem feriados (`businessMinutesBetween`, `response-alert.types.ts`).
 */
import type { IsoDate } from './api.types.js';

/** Maior período aceito, em dias (inclusive). Mais que isso → `VALIDATION_ERROR`. */
export const RESPONSE_TIME_MAX_PERIOD_DAYS = 93;

/**
 * `responderId` da linha "Celular": resposta enviada pelo aparelho do
 * laboratório (`agent` sem `sender_id`, D-173), que não tem atendente.
 */
export const RESPONSE_TIME_PHONE_ID = 'phone';

/** Limites das faixas, em minutos úteis (inclusive): até 5, até 15, até 60, acima. */
export const RESPONSE_TIME_BUCKET_LIMITS = [5, 15, 60] as const;

export interface ResponseTimeQuery {
  startDate?: IsoDate;
  endDate?: IsoDate;
}

/** Quantos blocos respondidos caíram em cada faixa de minutos úteis. */
export interface ResponseTimeBuckets {
  /** 0 a 5 min. */
  upTo5: number;
  /** 6 a 15 min. */
  upTo15: number;
  /** 16 a 60 min. */
  upTo60: number;
  /** Mais de 60 min. */
  over60: number;
}

/** Média e mediana de um conjunto de esperas. `null` quando não há nenhuma. */
export interface ResponseTimeFigures {
  /** Blocos respondidos. */
  answered: number;
  /** Minutos úteis, 1 casa decimal. */
  averageMinutes: number | null;
  /** Minutos úteis, 1 casa decimal (média dos dois do meio quando a quantidade é par). */
  medianMinutes: number | null;
}

export interface ResponseTimeSummary extends ResponseTimeFigures {
  buckets: ResponseTimeBuckets;
  /**
   * Só os blocos que ABREM o atendimento: primeira mensagem de uma conversa
   * nova ou de uma conversa que voltou depois de encerrada.
   */
  firstResponse: ResponseTimeFigures;
}

/** Um dia do período, pela data LOCAL (fuso do expediente) do início da espera. */
export interface ResponseTimeDay extends ResponseTimeFigures {
  date: IsoDate;
}

export interface ResponseTimeTotalDay extends ResponseTimeDay {
  /** Blocos do dia sem resposta (aguardando + encerrados sem resposta). */
  unanswered: number;
}

/** Uma linha do ranking: quem respondeu. */
export interface ResponseTimeResponder extends ResponseTimeSummary {
  /** `users.id` ou `RESPONSE_TIME_PHONE_ID`. */
  responderId: string;
  /** Nome da atendente ou "Celular". */
  name: string;
  kind: 'user' | 'phone';
  /** Todos os dias do período, em ordem (dia sem resposta: zerado). */
  daily: ResponseTimeDay[];
}

export interface ResponseTimeTotal extends ResponseTimeSummary {
  /**
   * Blocos sem resposta humana. Não têm atendente: só aparecem no total.
   * `waiting` = conversa ainda esperando; `closed` = encerrada sem resposta;
   * `conversations` = conversas distintas com algum bloco sem resposta.
   */
  unanswered: { waiting: number; closed: number; conversations: number };
  daily: ResponseTimeTotalDay[];
}

/** `GET /analytics/response-time` — gestor/admin. */
export interface ResponseTimeReport {
  period: { startDate: IsoDate; endDate: IsoDate };
  /** Fuso IANA do expediente: as datas do período e do `daily` são locais a ele. */
  timezone: string;
  total: ResponseTimeTotal;
  /** Mediana menor primeiro; empate, quem respondeu mais blocos. */
  responders: ResponseTimeResponder[];
}
