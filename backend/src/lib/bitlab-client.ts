/**
 * Cliente da API de Orcamentos v1 do Bitlab (CRMLAB-52, D-185/D-187).
 * Contrato assumido: SERVICES.md §24.1. Mapeamento de campos: BUSINESS_RULES.md
 * §11.10.
 *
 * O Bitlab e tratado como FONTE INSTAVEL (avaliacao da sandbox, 18/09/2026):
 * o envelope e validado com zod, `sucesso`/`status` sao lidos alem do codigo
 * HTTP, envelope dentro de array e desembrulhado e numero que chega como
 * string numerica e aceito.
 *
 * Dado pessoal: `ID_CPF` e `DT_NASCIMENTO` nao entram no schema do orcamento —
 * o `z.object` descarta chave desconhecida, entao eles morrem aqui, na borda
 * (D-185 item 7). Nenhum corpo de resposta vai para log: pode trazer paciente.
 *
 * A chave (`apiKey`) so existe como argumento de `fetchBudgetsPage` e no header
 * da chamada. Nunca entra em mensagem de erro.
 */
import { z } from 'zod';
import type { LisSyncErrorKind } from '@crm-lab/shared';
import { isGatewayTimeout, withGatewayTimeout } from './fetch-timeout.js';
import type { LisSpreadsheetRow } from './lis-spreadsheet.js';

export const BITLAB_BUDGETS_PATH = '/v1/bitlab/orcamentos';
export const BITLAB_TIMEOUT_MS = 15_000;
export const BITLAB_TIMEZONE = 'America/Sao_Paulo';

/** Mensagens prontas para a tela (`lastError`). Nunca trazem a chave nem o corpo cru. */
export const BITLAB_ERROR_MESSAGES: Record<LisSyncErrorKind, string> = {
  auth: 'O Bitlab recusou a chave de acesso. A sincronização foi desligada: confira a chave e ligue de novo.',
  unavailable: 'O Bitlab não respondeu (fora do ar ou tempo esgotado). A próxima tentativa é automática.',
  contract: 'A resposta do Bitlab veio num formato inesperado. Nada foi gravado nesta rodada.',
  rejected: 'O Bitlab recusou a consulta.',
};

export class BitlabError extends Error {
  readonly kind: LisSyncErrorKind;
  /** Texto para a tela — `message` e para log. */
  readonly userMessage: string;

  constructor(kind: LisSyncErrorKind, detail: string, userMessage?: string) {
    super(`bitlab ${kind}: ${detail}`);
    this.name = 'BitlabError';
    this.kind = kind;
    this.userMessage = userMessage ?? BITLAB_ERROR_MESSAGES[kind];
  }
}

export function isBitlabError(error: unknown): error is BitlabError {
  return error instanceof BitlabError;
}

// ---------------------------------------------------------------------------
// Datas (D-187)
// ---------------------------------------------------------------------------

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/;

/**
 * `"2026-09-28T14:05:00.000Z"` -> `"2026-09-28"`, pelos COMPONENTES da string,
 * sem `new Date()` (D-187 — mesmo principio de D-110 para o serial do Excel).
 *
 * PENDENTE: se o Bitlab confirmar que o `Z` e UTC de verdade, trocar o corpo
 * por conversao para `America/Sao_Paulo` e emendar D-187.
 */
export function bitlabDateToIsoDate(value: string | null): string | null {
  if (value === null) return null;
  const match = ISO_DATE_PREFIX.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Marca d'agua (ISO) -> `dataInicio` no formato documentado pelo Bitlab
 * (`YYYY-MM-DD HH:mm:ss`), pelos componentes — mesma hipotese de D-187.
 */
export function watermarkToBitlabDateTime(watermark: string): string | null {
  const match = ISO_DATE_TIME.exec(watermark.trim());
  if (!match) return null;
  return `${match[1]} ${match[2]}`;
}

/** Relogio de Brasilia no formato do Bitlab. Usado em `dataFim` e na primeira carga. */
export function saoPauloDateTime(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BITLAB_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// ---------------------------------------------------------------------------
// Schema da resposta (SERVICES.md §24.1)
// ---------------------------------------------------------------------------

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/** number, string numerica (`"250.00"`) ou null/ausente -> number | null. */
const money = z
  .union([z.number(), z.string().trim().regex(NUMERIC_STRING).transform(Number), z.null()])
  .optional()
  .transform((v) => (v === undefined ? null : v));

/** string, ou null/ausente/vazia -> string | null. */
const text = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null || v.trim() === '' ? null : v));

const budgetNumber = z
  .union([z.number().int().nonnegative(), z.string().trim().regex(/^\d+$/)])
  .transform((v) => String(v).replace(/^0+(?=\d)/, ''));

/** So os campos que o CRM usa — o resto (CPF, nascimento, ...) e descartado aqui. */
const budgetSchema = z.object({
  ORCAMENTO: budgetNumber,
  DATA_ORÇAMENTO: text,
  NM_PACIENTE: text,
  CONVENIO1: text,
  VL_TOTAL1: money,
  CONVENIO2: text,
  VL_TOTAL2: money,
  CONVENIO3: text,
  VL_TOTAL3: money,
  MEDIA_CONVENIO: money,
  USUÁRIO: text,
  REQUISICAO: text,
  VALOR_REQUISICAO: money,
  Valor_Pago: money,
  Data_Pagamento: text,
});

const successSchema = z.object({
  sucesso: z.literal(true),
  status: z.enum(['LISTA', 'SEM_RESULTADOS']),
  avisos: z.array(z.string()).optional().default([]),
  paginacao: z.object({
    temProxima: z.boolean(),
    totalPaginas: z.number().int().nonnegative().optional(),
  }),
  marcaDagua: text,
  orcamentos: z.array(budgetSchema),
});

const errorSchema = z.object({
  sucesso: z.literal(false),
  status: z.string().optional(),
  erro: z.object({ codigo: z.string().optional(), mensagem: z.string().optional() }).optional(),
});

type BitlabBudget = z.infer<typeof budgetSchema>;

/** Um orcamento da API -> a MESMA linha interna que a planilha produz (§11.10). */
export function toLisRow(budget: BitlabBudget): LisSpreadsheetRow {
  return {
    number: budget.ORCAMENTO,
    issuedOn: bitlabDateToIsoDate(budget.DATA_ORÇAMENTO),
    patientName: budget.NM_PACIENTE,
    insurance1: budget.CONVENIO1,
    value1: budget.VL_TOTAL1,
    insurance2: budget.CONVENIO2,
    value2: budget.VL_TOTAL2,
    insurance3: budget.CONVENIO3,
    value3: budget.VL_TOTAL3,
    attendantName: budget.USUÁRIO,
    insuranceAverage: budget.MEDIA_CONVENIO,
    requisitionNumber: budget.REQUISICAO,
    requisitionValue: budget.VALOR_REQUISICAO,
    paidValue: budget.Valor_Pago,
    paidOn: bitlabDateToIsoDate(budget.Data_Pagamento),
  };
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export interface BitlabBudgetsQuery {
  dataInicio: string;
  dataFim: string;
  pagina: number;
  tamanhoPagina: number;
}

export interface BitlabBudgetsPage {
  rows: LisSpreadsheetRow[];
  hasNext: boolean;
  watermark: string | null;
  /** `avisos[]` nao vazio ou `X-API-Deprecation: true` — o Bitlab avisando mudanca. */
  deprecationNotices: string[];
}

export interface BitlabClient {
  fetchBudgetsPage(apiKey: string, query: BitlabBudgetsQuery): Promise<BitlabBudgetsPage>;
}

export interface BitlabClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function unwrapArray(body: unknown): unknown {
  return Array.isArray(body) && body.length === 1 ? body[0] : body;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function createBitlabClient(options: BitlabClientOptions): BitlabClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? BITLAB_TIMEOUT_MS;
  const url = options.baseUrl.replace(/\/+$/, '') + BITLAB_BUDGETS_PATH;

  return {
    async fetchBudgetsPage(apiKey, query) {
      let status: number;
      let raw: string;
      let deprecatedHeader: boolean;
      try {
        ({ status, raw, deprecatedHeader } = await withGatewayTimeout(
          { gateway: 'bitlab', path: BITLAB_BUDGETS_PATH, timeoutMs },
          async (signal) => {
            const res = await fetchImpl(url, {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...query, tipoData: 'alteracao' }),
              signal,
            });
            return {
              status: res.status,
              raw: await res.text(),
              deprecatedHeader: res.headers.get('x-api-deprecation')?.trim().toLowerCase() === 'true',
            };
          },
        ));
      } catch (error) {
        if (isGatewayTimeout(error)) throw new BitlabError('unavailable', 'timeout');
        const detail = error instanceof Error ? error.name : 'fetch falhou';
        throw new BitlabError('unavailable', `rede: ${detail}`);
      }

      if (status === 401 || status === 403) throw new BitlabError('auth', `HTTP ${status}`);
      if (status >= 500) throw new BitlabError('unavailable', `HTTP ${status}`);

      const body = unwrapArray(parseJson(raw));
      const failed = errorSchema.safeParse(body);
      if (failed.success) {
        const code = failed.data.status ?? failed.data.erro?.codigo ?? 'sem status';
        const message = failed.data.erro?.mensagem;
        throw new BitlabError(
          'rejected',
          `HTTP ${status} ${code}`,
          message ? `${BITLAB_ERROR_MESSAGES.rejected} (${message})` : undefined,
        );
      }
      if (status !== 200) throw new BitlabError('contract', `HTTP ${status} fora do contrato`);

      const parsed = successSchema.safeParse(body);
      if (!parsed.success) {
        // So o CAMINHO do problema — nunca o valor, que pode ser dado de paciente.
        const where = parsed.error.issues
          .slice(0, 3)
          .map((i) => i.path.join('.') || '(raiz)')
          .join(', ');
        throw new BitlabError('contract', `schema: ${where}`);
      }

      const notices = [...parsed.data.avisos];
      if (deprecatedHeader) notices.push('X-API-Deprecation: true');
      return {
        rows: parsed.data.orcamentos.map(toLisRow),
        hasNext: parsed.data.paginacao.temProxima,
        watermark: parsed.data.marcaDagua,
        deprecationNotices: notices,
      };
    },
  };
}
