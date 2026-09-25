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

// ---------------------------------------------------------------------------
// Importação do catálogo por CSV (CRMLAB-23, D-177/D-178 — API_CONTRACTS.md §4)
// ---------------------------------------------------------------------------

/** Teto do arquivo decodificado: 2 MiB (≈ 10 mil linhas de catálogo típico). */
export const EXAM_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Teto de linhas de dado (sem contar cabeçalho nem linhas em branco). */
export const EXAM_IMPORT_MAX_ROWS = 5000;
/** Teto de erros listados na resposta — `errorCount` continua exato. */
export const EXAM_IMPORT_MAX_ERRORS = 1000;

/**
 * Colunas canônicas da planilha, na ordem do modelo. O cabeçalho é casado sem
 * caixa e sem acento (`Código`, `CODIGO` e `codigo` valem o mesmo), e `prazo`
 * é aceito como `prazo_horas`. Coluna desconhecida é ignorada.
 */
export const EXAM_IMPORT_COLUMNS = [
  'nome',
  'codigo',
  'categoria',
  'descricao',
  'preparo',
  'prazo_horas',
  'preco_convenio',
  'preco_particular',
] as const;

export type ExamImportColumn = (typeof EXAM_IMPORT_COLUMNS)[number];

/** Sem estas no cabeçalho o arquivo inteiro é recusado (`missing_column`). */
export const EXAM_IMPORT_REQUIRED_COLUMNS: readonly ExamImportColumn[] = [
  'nome',
  'codigo',
  'preco_convenio',
  'preco_particular',
];

/** Linha de exemplo do modelo baixável — mesma ordem de `EXAM_IMPORT_COLUMNS`. */
export const EXAM_IMPORT_TEMPLATE_EXAMPLE: Record<ExamImportColumn, string> = {
  nome: 'Hemograma completo',
  codigo: 'HC',
  categoria: 'Hematologia',
  descricao: 'Análise completa do sangue',
  preparo: 'Jejum não obrigatório',
  prazo_horas: '24',
  preco_convenio: '75,00',
  preco_particular: '89,90',
};

/**
 * Motivo de recusa do ARQUIVO inteiro (`VALIDATION_ERROR`, `details.reason`).
 * `invalid_rows` só aparece no `POST /exams/import` (confirmar): há linha com
 * erro e, pela regra tudo-ou-nada, nada foi gravado.
 */
export type ExamImportInvalidReason =
  | 'invalid_encoding'
  | 'malformed'
  | 'empty'
  | 'missing_column'
  | 'duplicate_column'
  | 'too_many_rows'
  | 'invalid_rows';

export interface ImportExamCatalogRequest {
  /** 1..255 caracteres, só exibição. */
  fileName: string;
  /** CSV em base64 (mesma disciplina de `POST /lis-imports`). */
  contentBase64: string;
}

/** Erro de uma linha. `line` é a linha da planilha (cabeçalho = 1). */
export interface ExamImportRowError {
  line: number;
  /** `null` quando o erro é da linha inteira, não de uma coluna. */
  column: ExamImportColumn | null;
  message: string;
}

export type ExamImportAction = 'create' | 'update';

/** Linha válida, já interpretada — o que vai ser gravado se confirmar. */
export interface ExamImportRow {
  line: number;
  action: ExamImportAction;
  code: string;
  name: string;
  category: string | null;
  turnaroundHours: number | null;
  pricePrivate: number;
  priceInsurance: number;
}

/** `POST /exams/import/preview` — não grava nada. */
export interface ExamImportPreview {
  fileName: string;
  /** Linhas de dado lidas (sem cabeçalho e sem linhas em branco). */
  totalRows: number;
  createCount: number;
  updateCount: number;
  /** Linhas com pelo menos um erro. */
  errorCount: number;
  errors: ExamImportRowError[];
  /** `true` quando `errors` foi cortado em `EXAM_IMPORT_MAX_ERRORS`. */
  errorsTruncated: boolean;
  /** Só as linhas válidas, na ordem do arquivo. */
  rows: ExamImportRow[];
}

/** `POST /exams/import` — gravou tudo (uma transação). */
export interface ExamImportResult {
  fileName: string;
  totalRows: number;
  created: number;
  updated: number;
}
