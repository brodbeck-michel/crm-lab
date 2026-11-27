/**
 * Cliente da consulta de requisicoes do Bitlab (CRMLAB-200, D-338). Contrato: SERVICES.md §24.2;
 * mapeamento: BUSINESS_RULES.md §11.13.
 *
 * Mesma postura do cliente de orcamentos (`bitlab-client.ts`): envelope validado com zod, numero
 * em string aceito, status HTTP convertido em `BitlabError` e corpo cru nunca em log. O envelope
 * e diferente do de orcamentos: `success`/`error`, paginacao por `cursor`, no maximo 1 dia por
 * chamada. A API nao manda dado de paciente; se mandasse, o `z.object` descartaria aqui.
 */
import { z } from 'zod';
import { BitlabError, BITLAB_ERROR_MESSAGES, normalizeRequestingDoctor, parseBitlabDateTime, type RequestingDoctor } from './bitlab-client.js';
import { isGatewayTimeout, withGatewayTimeout } from './fetch-timeout.js';

/** Relativo a `BITLAB_API_BASE_URL` (`.../v1` ou `.../homologacao`, D-337). */
export const BITLAB_REQUISITIONS_PATH = '/requisicoes/consulta';
export const BITLAB_REQUISITIONS_TIMEOUT_MS = 30_000;
/** Maximo do Bitlab (Swagger, 26/11/2026). */
export const REQUISITIONS_PAGE_SIZE = 1000;

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

const money = z
  .union([z.number(), z.string().trim().regex(NUMERIC_STRING).transform(Number), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null ? 0 : v));

const text = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t === '' ? null : t;
  });

const paymentSchema = z.object({
  id: text,
  data: text,
  forma: text,
  valor: money,
  situacao: text,
});

/** Tetos dos arrays (mesma razao do D-281): falha rapido numa resposta anomala. */
const MAX_PER_PAGE = 5000;
const MAX_PAYMENTS = 200;

const requisitionSchema = z.object({
  requisicao: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  dataRequisicao: text,
  orcamento: text,
  convenio: z
    .object({ codigo: text, nome: text, tipo: text })
    .nullable()
    .optional()
    .transform((v) => v ?? { codigo: null, nome: null, tipo: null }),
  medico: z
    .object({ nome: text, conselho: text, numero: text, uf: text })
    .nullable()
    .optional()
    .transform((v) => v ?? { nome: null, conselho: null, numero: null, uf: null }),
  usuario: text,
  dataAlteracao: text,
  cobrancaPaciente: z
    .object({
      valorCobrado: money,
      descontos: money,
      acrescimos: money,
      valorPago: money,
      pagamentos: z.array(paymentSchema).max(MAX_PAYMENTS).nullable().optional(),
    })
    .nullable()
    .optional(),
  faturamentoConvenio: z.object({ valorConvenio: money }).nullable().optional(),
});

const excludedSchema = z.object({
  requisicao: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
});

const successSchema = z.object({
  success: z.literal(true),
  status: z.string().optional(),
  paginacao: z
    .object({
      temProxima: z.boolean(),
      proximoCursor: text,
    })
    .optional()
    .transform((v) => v ?? { temProxima: false, proximoCursor: null }),
  marcaDagua: text,
  requisicoes: z.array(requisitionSchema).max(MAX_PER_PAGE).nullable().optional(),
  requisicoesExcluidas: z.array(excludedSchema).max(MAX_PER_PAGE).nullable().optional(),
});

const errorSchema = z.object({
  success: z.literal(false),
  status: z.string().optional(),
  error: z.string().optional(),
});

type BitlabRequisition = z.infer<typeof requisitionSchema>;

export interface LisRequisitionPayment {
  paymentKey: string;
  /** `YYYY-MM-DD HH:mm:ss`, Brasilia. */
  paidAt: string | null;
  paidOn: string | null;
  paidValue: number;
  status: 'ativo' | 'estornado';
  paymentMethod: string | null;
}

/** Uma requisicao normalizada (BUSINESS_RULES §11.13). */
export interface LisRequisitionRow extends RequestingDoctor {
  number: string;
  requestedAt: string | null;
  requestedOn: string | null;
  budgetNumber: string | null;
  insuranceCode: string | null;
  insuranceName: string | null;
  insuranceType: string | null;
  attendantName: string | null;
  /** `valorCobrado - descontos + acrescimos`. */
  patientValue: number;
  /** `faturamentoConvenio.valorConvenio`. */
  insuranceValue: number;
  paidValue: number;
  changedAt: string | null;
  payments: LisRequisitionPayment[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cut(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

export function toRequisitionRow(r: BitlabRequisition): LisRequisitionRow {
  const requestedAt = parseBitlabDateTime(r.dataRequisicao);
  const charge = r.cobrancaPaciente;
  const payments: LisRequisitionPayment[] = [];
  const seen = new Set<string>();
  for (const [i, p] of (charge?.pagamentos ?? []).entries()) {
    const paidAt = parseBitlabDateTime(p.data);
    // Sem id: chave estavel pela posicao, data e valor (o Bitlab sempre manda id hoje).
    const key = (p.id ?? `sem-id:${i}:${paidAt ?? ''}:${p.valor}`).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    payments.push({
      paymentKey: key,
      paidAt,
      paidOn: paidAt?.slice(0, 10) ?? null,
      paidValue: round2(p.valor),
      status: p.situacao?.toUpperCase() === 'ESTORNADO' ? 'estornado' : 'ativo',
      paymentMethod: cut(p.forma, 60),
    });
  }
  return {
    number: r.requisicao.slice(0, 50),
    requestedAt,
    requestedOn: requestedAt?.slice(0, 10) ?? null,
    budgetNumber: r.orcamento === null ? null : r.orcamento.replace(/^0+(?=\d)/, '').slice(0, 50),
    insuranceCode: cut(r.convenio.codigo, 30),
    insuranceName: cut(r.convenio.nome, 255),
    insuranceType: cut(r.convenio.tipo, 20),
    attendantName: cut(r.usuario, 255),
    ...normalizeRequestingDoctor(r.medico.nome, r.medico.conselho, r.medico.numero, r.medico.uf),
    patientValue: round2((charge?.valorCobrado ?? 0) - (charge?.descontos ?? 0) + (charge?.acrescimos ?? 0)),
    insuranceValue: round2(r.faturamentoConvenio?.valorConvenio ?? 0),
    paidValue: round2(charge?.valorPago ?? 0),
    changedAt: parseBitlabDateTime(r.dataAlteracao),
    payments,
  };
}

export interface BitlabRequisitionsQuery {
  /** `YYYY-MM-DD HH:mm:ss` (Brasilia). No maximo 1 dia ate `dataFim`. */
  dataInicio: string;
  dataFim: string;
  tipoData: 'emissao' | 'alteracao';
  cursor: string | null;
}

export interface BitlabRequisitionsPage {
  rows: LisRequisitionRow[];
  excluded: string[];
  hasNext: boolean;
  nextCursor: string | null;
  /** `YYYY-MM-DD HH:mm:ss` ou `null`. */
  watermark: string | null;
}

export interface BitlabRequisitionsClient {
  fetchRequisitionsPage(apiKey: string, query: BitlabRequisitionsQuery): Promise<BitlabRequisitionsPage>;
}

export interface BitlabRequisitionsClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function createBitlabRequisitionsClient(options: BitlabRequisitionsClientOptions): BitlabRequisitionsClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BITLAB_REQUISITIONS_TIMEOUT_MS;
  const url = options.baseUrl.replace(/\/+$/, '') + BITLAB_REQUISITIONS_PATH;

  return {
    async fetchRequisitionsPage(apiKey, query) {
      let status: number;
      let raw: string;
      try {
        ({ status, raw } = await withGatewayTimeout(
          { gateway: 'bitlab', path: BITLAB_REQUISITIONS_PATH, timeoutMs },
          async (signal) => {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...query, tamanhoPagina: REQUISITIONS_PAGE_SIZE }),
              signal,
            });
            return { status: res.status, raw: await res.text() };
          },
        ));
      } catch (error) {
        if (isGatewayTimeout(error)) throw new BitlabError('unavailable', 'timeout');
        const detail = error instanceof Error ? error.name : 'fetch falhou';
        throw new BitlabError('unavailable', `rede: ${detail}`);
      }

      if (status === 401 || status === 403) throw new BitlabError('auth', `HTTP ${status}`);
      if (status === 429 || status >= 500) throw new BitlabError('unavailable', `HTTP ${status}`);

      const body = parseJson(raw);
      const failed = errorSchema.safeParse(body);
      if (failed.success) {
        // A chave invalida volta 200/400 com `success: false` em vez de 401 (visto em 27/11/2026).
        const message = failed.data.error ?? '';
        if (/chave/i.test(message)) throw new BitlabError('auth', `HTTP ${status} chave`);
        throw new BitlabError(
          'rejected',
          `HTTP ${status} ${failed.data.status ?? 'sem status'}`,
          message ? `${BITLAB_ERROR_MESSAGES.rejected} (${message.slice(0, 200)})` : undefined,
        );
      }
      if (status !== 200) throw new BitlabError('contract', `HTTP ${status} fora do contrato`);

      const parsed = successSchema.safeParse(body);
      if (!parsed.success) {
        const where = parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join('.') || '(raiz)')
          .join(', ');
        throw new BitlabError('contract', `schema: ${where}`);
      }
      const watermark = parseBitlabDateTime(parsed.data.marcaDagua);
      if (parsed.data.marcaDagua !== null && watermark === null) {
        throw new BitlabError('contract', 'schema: marcaDagua');
      }
      return {
        rows: (parsed.data.requisicoes ?? []).map(toRequisitionRow),
        excluded: (parsed.data.requisicoesExcluidas ?? []).map((e) => e.requisicao),
        hasNext: parsed.data.paginacao.temProxima,
        nextCursor: parsed.data.paginacao.proximoCursor,
        watermark,
      };
    },
  };
}
