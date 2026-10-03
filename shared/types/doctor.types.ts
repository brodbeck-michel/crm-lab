/**
 * Médicos solicitantes do laboratório — CRMLAB-86 (D-255), épico CRMLAB-85
 * (Visitação Médica). Espelha docs/api/API_CONTRACTS.md §13 e
 * docs/database/SCHEMA.md §35.
 *
 * Base dos próximos cards do épico (agenda de visitas, check-in/out, linha do
 * tempo): eles vão referenciar `Doctor.id`. `proposals.requestingDoctor`
 * continua texto livre — este cadastro NÃO se liga à proposta (D-255 item 6).
 *
 * As regras de normalização de CRM/UF moram AQUI (e não no backend) para que o
 * formulário e o servidor nunca discordem sobre o que é "o mesmo CRM".
 */
import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

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
  specialty: string | null;
  /** Clínica/consultório. */
  clinic: string | null;
  address: string | null;
  /** Telefone/WhatsApp, como digitado. */
  phone: string | null;
  email: string | null;
  /** Secretária/contato. */
  contactName: string | null;
  /** Melhor dia e horário para visita — texto livre. */
  visitPreference: string | null;
  notes: string | null;
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
}

export interface ListDoctorsResponse {
  doctors: Doctor[];
  pagination: PaginationMeta;
}

/**
 * Corpo de `POST /doctors`. Campos opcionais ausentes, vazios ou `null` são
 * gravados como `null`. `crm` sem `crmUf` → `VALIDATION_ERROR`.
 */
export interface CreateDoctorRequest {
  name: string;
  crm?: string | null;
  crmUf?: string | null;
  specialty?: string | null;
  clinic?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  visitPreference?: string | null;
  notes?: string | null;
  responsibleId?: string | null;
}

/**
 * Corpo de `PATCH /doctors/:id` — parcial. `null` (ou string vazia) limpa o
 * campo. Ativar/inativar NÃO passa por aqui: `POST /doctors/:id/inactivate|reactivate`.
 */
export type UpdateDoctorRequest = Partial<CreateDoctorRequest>;

/** `details` do `409 DOCTOR_CRM_ALREADY_EXISTS` — o médico que já usa o CRM. */
export interface DoctorCrmConflictDetails {
  crm: string;
  crmUf: string;
  existingDoctor: { id: string; name: string; isActive: boolean };
}
