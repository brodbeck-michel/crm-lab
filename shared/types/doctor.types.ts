/**
 * Médicos solicitantes do laboratório — CRMLAB-86 (D-255), épico CRMLAB-85
 * (Visitação Médica). Espelha docs/api/API_CONTRACTS.md §13 e
 * docs/database/SCHEMA.md §35 e §51.
 *
 * Cadastro ampliado no CRMLAB-188 (D-328): especialidade por lista do
 * laboratório, aniversário, dados da clínica, horário estruturado para
 * representante, parceria, endereço estruturado, bloco Secretária e curva ABC
 * automática. A proposta pode apontar o médico (`doctorId`);
 * `requestingDoctor` segue texto livre.
 *
 * As regras de normalização moram AQUI (e não no backend) para que o
 * formulário e o servidor nunca discordem sobre o que é "o mesmo CRM".
 */
import type { IsoDate, IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';
import type { TenantRole } from './auth.types.js';

/** As 27 unidades da federação — UF do conselho regional (CRM-UF). */
export const BRAZIL_UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

export type BrazilUf = (typeof BRAZIL_UFS)[number];

export function isBrazilUf(value: string): value is BrazilUf {
  return (BRAZIL_UFS as readonly string[]).includes(value);
}

/** Tamanho máximo do CRM depois da normalização (coluna `doctors.crm`). */
export const DOCTOR_CRM_MAX_DIGITS = 10;

/**
 * CRM → só dígitos (`"CRM 12.345"` → `"12345"`). Vazio (ou sem nenhum dígito)
 * vira `null`: CRM é opcional.
 */
export function normalizeCrm(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/** UF → maiúscula, sem espaço. Vazia vira `null`. Não valida — veja `isBrazilUf`. */
export function normalizeUf(value: string | null | undefined): string | null {
  const uf = (value ?? '').trim().toUpperCase();
  return uf.length > 0 ? uf : null;
}

// ---------------------------------------------------------------------------
// Cadastro ampliado (CRMLAB-188, D-328)
// ---------------------------------------------------------------------------

/**
 * Dobra para comparar nomes: sem acento, minúsculo, espaços colapsados. É a
 * chave de "mesma especialidade" e do vínculo proposta ↔ médico do backfill.
 */
export function normalizeLookupName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Especialidades semeadas em todo laboratório (lista do CFM, as mais comuns).
 * A migração 071 repete esta lista em SQL (migração é retrato do dia); o
 * service semeia o laboratório que ainda não tem nenhuma (D-328 item 1).
 */
export const DEFAULT_DOCTOR_SPECIALTIES = [
  'Acupuntura',
  'Alergia e Imunologia',
  'Anestesiologia',
  'Angiologia',
  'Cardiologia',
  'Cirurgia do Aparelho Digestivo',
  'Cirurgia Geral',
  'Cirurgia Pediátrica',
  'Cirurgia Plástica',
  'Cirurgia Vascular',
  'Clínica Médica',
  'Coloproctologia',
  'Dermatologia',
  'Endocrinologia e Metabologia',
  'Gastroenterologia',
  'Genética Médica',
  'Geriatria',
  'Ginecologia e Obstetrícia',
  'Hematologia e Hemoterapia',
  'Homeopatia',
  'Infectologia',
  'Mastologia',
  'Medicina de Família e Comunidade',
  'Medicina do Trabalho',
  'Medicina Esportiva',
  'Medicina Intensiva',
  'Nefrologia',
  'Neurocirurgia',
  'Neurologia',
  'Nutrologia',
  'Oftalmologia',
  'Oncologia Clínica',
  'Ortopedia e Traumatologia',
  'Otorrinolaringologia',
  'Patologia Clínica/Medicina Laboratorial',
  'Pediatria',
  'Pneumologia',
  'Psiquiatria',
  'Radiologia e Diagnóstico por Imagem',
  'Reumatologia',
  'Urologia',
] as const;

/** Teto do nome da especialidade (coluna `doctor_specialties.name`). */
export const DOCTOR_SPECIALTY_NAME_MAX_LENGTH = 120;

/** Especialidade da lista do laboratório. */
export interface DoctorSpecialty {
  id: string;
  name: string;
  /** Inativa não é oferecida para cadastro novo; quem já a usa continua com ela. */
  isActive: boolean;
}

export interface ListDoctorSpecialtiesQuery {
  /** Omitido = ativas e inativas. */
  active?: boolean;
}

/** Lista curta, sem paginação (exceção ao envelope, como `/conversations/assignees`). */
export interface ListDoctorSpecialtiesResponse {
  specialties: DoctorSpecialty[];
}

/** `POST /doctors/specialties` — gestor/admin. */
export interface CreateDoctorSpecialtyRequest {
  name: string;
}

/** `PATCH /doctors/specialties/:id` — gestor/admin. */
export interface UpdateDoctorSpecialtyRequest {
  name?: string;
  isActive?: boolean;
}

/** `details` do `409 DOCTOR_SPECIALTY_ALREADY_EXISTS`. */
export interface DoctorSpecialtyConflictDetails {
  existingSpecialty: DoctorSpecialty;
}

/** Dia da semana: 0 = domingo … 6 = sábado (mesma convenção de `Date#getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6] as const;

export const WEEKDAY_SHORT_LABELS: Readonly<Record<Weekday, string>> = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sáb',
};

/** Faixa em que o médico recebe representante. `start < end`, horário local `HH:MM`. */
export interface DoctorVisitHours {
  /** Sem repetição, ao menos um dia. Ordenados na resposta. */
  weekdays: Weekday[];
  start: string;
  end: string;
}

/** Máximo de faixas de horário por médico. */
export const DOCTOR_VISIT_HOURS_MAX = 14;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeHHMM(value: string): boolean {
  return HHMM.test(value);
}

/** Ano mínimo aceito em aniversário com ano. */
export const BIRTH_YEAR_MIN = 1900;

/**
 * Dia/mês (e ano opcional) formam uma data possível? Sem ano, 29/02 vale
 * (aniversário de quem nasceu em ano bissexto).
 */
export function isValidBirthday(day: number, month: number, year?: number | null): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const reference = year ?? 2000;
  const daysInMonth = new Date(Date.UTC(reference, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** CEP → só os 8 dígitos; qualquer outra coisa vira `null` (inválido ou vazio). */
export function normalizeCep(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

/** `88701100` → `88701-100`. */
export function formatCep(cep: string): string {
  return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep;
}

/**
 * Telefone digitado → número para `https://wa.me/<n>`. DDD + número (10 ou 11
 * dígitos) ganha o 55; já com 55 (12 ou 13) fica; o resto não vira link.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
}

/** Curva ABC do médico (D-328 item 6). Calculada, nunca editada. */
export type DoctorAbcClass = 'A' | 'B' | 'C';

export const DOCTOR_ABC_CLASSES: readonly DoctorAbcClass[] = ['A', 'B', 'C'] as const;

/** Acumulado (em fração do total) até onde vai cada classe. */
export const DOCTOR_ABC_THRESHOLDS = { A: 0.8, B: 0.95 } as const;

/** Janela da base de cálculo, em meses. */
export const DOCTOR_ABC_WINDOW_MONTHS = 12;

/**
 * Classifica por Pareto. `values` = base de cada médico (soma das vendas na
 * janela). Regra (D-328 item 6):
 *  - ordena do maior para o menor;
 *  - o médico é A se o acumulado ANTES dele é < 80% do total, B se < 95%,
 *    senão C — assim o maior vendedor é sempre A, mesmo concentrando 90%;
 *  - empate: todos com o mesmo valor ficam com a classe do primeiro do grupo
 *    (a ordem entre eles não muda a classe de ninguém);
 *  - base 0 (sem venda) é sempre C; total 0 → todos C.
 */
export function classifyAbc(values: ReadonlyMap<string, number>): Map<string, DoctorAbcClass> {
  const entries = [...values.entries()]
    .map(([id, value]): [string, number] => [id, Math.max(value, 0)])
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const result = new Map<string, DoctorAbcClass>();
  let accumulated = 0;
  let index = 0;
  while (index < entries.length) {
    const value = entries[index]?.[1] ?? 0;
    let groupEnd = index;
    while (groupEnd < entries.length && entries[groupEnd]?.[1] === value) groupEnd += 1;
    let cls: DoctorAbcClass = 'C';
    if (value > 0 && total > 0) {
      const before = accumulated / total;
      cls = before < DOCTOR_ABC_THRESHOLDS.A ? 'A' : before < DOCTOR_ABC_THRESHOLDS.B ? 'B' : 'C';
    }
    for (let i = index; i < groupEnd; i += 1) {
      const id = entries[i]?.[0];
      if (id !== undefined) result.set(id, cls);
      accumulated += value;
    }
    index = groupEnd;
  }
  return result;
}

/** Responsável pela carteira — só o que a tela precisa mostrar. */
export interface DoctorResponsible {
  id: string;
  name: string;
}

export interface Doctor {
  id: string;
  name: string;
  /** Só dígitos. `null` = sem CRM informado. */
  crm: string | null;
  /** UF do CRM, maiúscula. Sempre preenchida quando há `crm`. */
  crmUf: string | null;
  /** Especialidade da lista do laboratório (CRMLAB-188). */
  specialtyId: string | null;
  /**
   * Nome da especialidade (da lista). Médico ainda sem `specialtyId` mostra o
   * texto livre antigo. Só leitura: escreve-se por `specialtyId`.
   */
  specialty: string | null;
  /** Aniversário: dia e mês andam juntos; ano opcional (CRMLAB-188). */
  birthDay: number | null;
  birthMonth: number | null;
  birthYear: number | null;
  /** Clínica/consultório. */
  clinic: string | null;
  /** Atende particular. `null` = não informado. */
  acceptsPrivate: boolean | null;
  /** Consultas por mês, total. */
  monthlyConsultations: number | null;
  /** Consultas por mês particulares (≤ total). */
  monthlyPrivateConsultations: number | null;
  /** Valor da consulta, decimal (`350.00`). */
  consultationFee: number | null;
  /** Horário em que recebe representante, estruturado. `[]` = não informado. */
  visitHours: DoctorVisitHours[];
  /** Observação de horário — texto livre (o "melhor dia e horário" antigo). */
  visitPreference: string | null;
  isPartner: boolean;
  partnerSince: IsoDate | null;
  partnershipNotes: string | null;
  /** Endereço estruturado (CRMLAB-188). CEP só dígitos; UF maiúscula. */
  addressZip: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressDistrict: string | null;
  addressCity: string | null;
  addressState: string | null;
  /** Endereço em texto livre (antigo). A tela mostra se os campos acima estiverem vazios. */
  address: string | null;
  /** Telefone/WhatsApp, como digitado. */
  phone: string | null;
  email: string | null;
  /** Secretária (CRMLAB-188). */
  secretaryName: string | null;
  secretaryBirthDay: number | null;
  secretaryBirthMonth: number | null;
  secretaryBirthYear: number | null;
  secretaryPhone: string | null;
  secretaryNotes: string | null;
  /**
   * @deprecated espelho de `secretaryName` (coluna antiga `contact_name`,
   * mantida até a migração que a remover — regra das 3 migrações). Só leitura.
   */
  contactName: string | null;
  notes: string | null;
  /** Curva ABC — calculada pelo servidor (D-328 item 6). `null` = nunca calculada. */
  abcClass: DoctorAbcClass | null;
  /** Soma das vendas (`totalPrice` das propostas `ganho`) nos 12 meses do cálculo. */
  abcBaseValue: number | null;
  abcCalculatedAt: IsoDateTime | null;
  /** Responsável pela carteira (usuário do laboratório). `null` = sem responsável. */
  responsible: DoctorResponsible | null;
  /** Inativar substitui apagar (D-255 item 4). */
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type DoctorSortBy = 'name' | 'createdAt' | 'updatedAt';

export interface ListDoctorsQuery extends PaginationQuery {
  /** Casa nome (sem caixa nem acento) e CRM (pelos dígitos do termo). */
  search?: string;
  /** Omitido = ativos e inativos. */
  active?: boolean;
  /** Só a carteira deste usuário. */
  responsibleId?: string;
  /** Só desta especialidade (CRMLAB-188). */
  specialtyId?: string;
  /** Só desta classe da curva ABC (CRMLAB-188). */
  abcClass?: DoctorAbcClass;
  /**
   * D-329: só os médicos sem responsável, com responsável de perfil inelegível
   * (fora de `VISITATION_RESPONSIBLE_ROLES`) ou inativo — o filtro de atribuição
   * do gestor. Para o representante, combinado com a carteira, vem vazio.
   */
  unassigned?: boolean;
}

export interface ListDoctorsResponse {
  doctors: Doctor[];
  pagination: PaginationMeta;
}

// --- Carteiras e transferência (CRMLAB-189, D-329) ---

/** Corte pela classificação ABC do médico — entra quando o CRMLAB-188 for integrado. */
export interface DoctorPortfolioAbc {
  A: number;
  B: number;
  C: number;
  unclassified: number;
}

export interface DoctorPortfolioCounts {
  /** Ativos e inativos. */
  doctorCount: number;
  activeDoctorCount: number;
  /** Opcional: só vem quando houver classificação ABC no médico (CRMLAB-188). */
  abc?: DoctorPortfolioAbc;
}

/** Uma carteira: o responsável e quantos médicos ele tem. */
export interface DoctorPortfolio extends DoctorPortfolioCounts {
  responsible: { id: string; name: string; role: TenantRole };
}

/**
 * `GET /doctors/portfolios` (gestor/admin). Linhas = representantes ativos (mesmo
 * com zero médicos) + usuários ativos de perfil elegível com médico. O resto vai
 * para `unassigned` — cada médico conta uma vez.
 */
export interface ListDoctorPortfoliosResponse {
  portfolios: DoctorPortfolio[];
  unassigned: DoctorPortfolioCounts;
}

/** Teto de médicos por transferência. */
export const DOCTOR_TRANSFER_MAX = 200;

/** `GET /doctors/lookup` — busca do formulário de proposta (D-329 item 12). */
export const DOCTOR_LOOKUP_DEFAULT_LIMIT = 8;
export const DOCTOR_LOOKUP_MAX_LIMIT = 20;

export interface DoctorLookupQuery {
  /** Nome (sem acento/caixa) ou dígitos do CRM; 2–100 caracteres. */
  search: string;
  /** 1–20, padrão 8. */
  limit?: number;
}

/** Só o mínimo para escolher o médico — nada de contato, carteira ou ABC. */
export interface DoctorLookupItem {
  id: string;
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialty: string | null;
}

export interface DoctorLookupResponse {
  doctors: DoctorLookupItem[];
}

/** `POST /doctors/transfer` (gestor/admin). */
export interface TransferDoctorsRequest {
  /** 1..`DOCTOR_TRANSFER_MAX`, sem repetição. */
  doctorIds: string[];
  /** Usuário ativo, de perfil elegível, do mesmo laboratório. */
  toUserId: string;
  /** Leva as visitas `agendada` futuras que estavam com o responsável anterior. Default `false`. */
  includeFutureVisits?: boolean;
}

export interface TransferDoctorsResponse {
  transferredDoctors: number;
  movedVisits: number;
}

/**
 * Corpo de `POST /doctors`. Campos opcionais ausentes, vazios ou `null` são
 * gravados como `null`. `crm` sem `crmUf` → `VALIDATION_ERROR`.
 * Desde o CRMLAB-188, `specialty` (texto) e `contactName` não entram mais:
 * use `specialtyId` e `secretaryName`.
 */
export interface CreateDoctorRequest {
  name: string;
  crm?: string | null;
  crmUf?: string | null;
  /** Especialidade ATIVA da lista do laboratório. */
  specialtyId?: string | null;
  birthDay?: number | null;
  birthMonth?: number | null;
  birthYear?: number | null;
  clinic?: string | null;
  acceptsPrivate?: boolean | null;
  monthlyConsultations?: number | null;
  monthlyPrivateConsultations?: number | null;
  consultationFee?: number | null;
  /** Substitui a lista inteira. `[]`/`null` limpa. */
  visitHours?: DoctorVisitHours[] | null;
  visitPreference?: string | null;
  isPartner?: boolean;
  partnerSince?: IsoDate | null;
  partnershipNotes?: string | null;
  addressZip?: string | null;
  addressStreet?: string | null;
  addressNumber?: string | null;
  addressComplement?: string | null;
  addressDistrict?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  secretaryName?: string | null;
  secretaryBirthDay?: number | null;
  secretaryBirthMonth?: number | null;
  secretaryBirthYear?: number | null;
  secretaryPhone?: string | null;
  secretaryNotes?: string | null;
  notes?: string | null;
  responsibleId?: string | null;
}

/**
 * Corpo de `PATCH /doctors/:id` — parcial. `null` (ou string vazia) limpa o
 * campo. Ativar/inativar NÃO passa por aqui: `POST /doctors/:id/inactivate|reactivate`.
 * A curva ABC também não (é calculada).
 */
export type UpdateDoctorRequest = Partial<CreateDoctorRequest>;

/** Resposta de `POST /doctors/abc/recalculate` (gestor/admin). */
export interface DoctorAbcRecalculation {
  calculatedAt: IsoDateTime;
  /** Início da janela de 12 meses (propostas `ganho` com `closedAt` a partir daqui). */
  windowStart: IsoDateTime;
  /** Médicos classificados (ativos e inativos). */
  doctors: number;
  counts: Record<DoctorAbcClass, number>;
}

/** `details` do `409 DOCTOR_CRM_ALREADY_EXISTS` — o médico que já usa o CRM. */
export interface DoctorCrmConflictDetails {
  crm: string;
  crmUf: string;
  existingDoctor: { id: string; name: string; isActive: boolean };
}
