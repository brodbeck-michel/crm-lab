import {
  WEEKDAY_SHORT_LABELS,
  formatCep,
  toWhatsAppNumber,
  type Doctor,
  type DoctorAbcClass,
  type DoctorVisitHours,
} from '@crm-lab/shared';
import { Chip, Tooltip } from '@/components/ui';
import type { ChipTone } from '@/components/ui';
import { formatMoney } from '@/lib/format';

/**
 * Peças de exibição do cadastro ampliado do médico (CRMLAB-188, D-328),
 * compartilhadas só entre as telas de Visitação (lista e ficha) — como
 * `agenda-ui.tsx`, não sobem para `components/`.
 */

const ABC_TONES: Record<DoctorAbcClass, ChipTone> = { A: 'positive', B: 'attention', C: 'inactive' };

/** "Base: R$ 1.234,56 nos últimos 12 meses, calculado em 21/11". */
export function abcTooltip(doctor: Pick<Doctor, 'abcBaseValue' | 'abcCalculatedAt'>): string {
  const base = formatMoney(doctor.abcBaseValue ?? 0);
  // Instante (UTC no fio) mostrado no dia local de quem lê.
  const day = doctor.abcCalculatedAt
    ? new Date(doctor.abcCalculatedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    : '—';
  return `Base: ${base} nos últimos 12 meses, calculado em ${day}`;
}

/** Selo da curva ABC. Sem cálculo ainda: nada. */
export function AbcBadge({ doctor }: { doctor: Pick<Doctor, 'abcClass' | 'abcBaseValue' | 'abcCalculatedAt'> }) {
  if (!doctor.abcClass) return null;
  return (
    <Tooltip content={abcTooltip(doctor)}>
      <span tabIndex={0} aria-label={`Curva ABC: ${doctor.abcClass}. ${abcTooltip(doctor)}`}>
        <Chip tone={ABC_TONES[doctor.abcClass]}>{doctor.abcClass}</Chip>
      </span>
    </Tooltip>
  );
}

const TWO = (n: number) => String(n).padStart(2, '0');

/** `14/03` ou `14/03/1980`; sem dia/mês, `null`. */
export function formatBirthday(day: number | null, month: number | null, year: number | null): string | null {
  if (day === null || month === null) return null;
  return year !== null ? `${TWO(day)}/${TWO(month)}/${year}` : `${TWO(day)}/${TWO(month)}`;
}

/** "Ter, Qui · 13:30–15:00". */
export function formatVisitHours(entry: DoctorVisitHours): string {
  const days = entry.weekdays.map((day) => WEEKDAY_SHORT_LABELS[day]).join(', ');
  return `${days} · ${entry.start}–${entry.end}`;
}

/** Endereço estruturado em até 2 linhas; sem nenhum campo novo, `null`. */
export function structuredAddress(doctor: Doctor): string[] | null {
  const line1 = [doctor.addressStreet, doctor.addressNumber, doctor.addressComplement].filter(Boolean).join(', ');
  const cityUf = [doctor.addressCity, doctor.addressState].filter(Boolean).join('/');
  const line2 = [doctor.addressDistrict, cityUf, doctor.addressZip ? `CEP ${formatCep(doctor.addressZip)}` : null]
    .filter(Boolean)
    .join(' · ');
  const lines = [line1, line2].filter((line) => line.length > 0);
  return lines.length > 0 ? lines : null;
}

export function formatFee(value: number | null): string | null {
  return value === null ? null : formatMoney(value);
}

/** Telefone com link `wa.me` quando forma número brasileiro (D-328 item 7). */
export function PhoneWithWhatsApp({ phone, label }: { phone: string | null; label: string }) {
  if (!phone) return null;
  const number = toWhatsAppNumber(phone);
  return (
    <span className="inline-flex flex-wrap items-center gap-sm">
      <span className="tabular-nums">{phone}</span>
      {number && (
        <a
          href={`https://wa.me/${number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-accent hover:underline"
          aria-label={`Abrir WhatsApp de ${label}`}
        >
          WhatsApp
        </a>
      )}
    </span>
  );
}

export const ACCEPTS_PRIVATE_LABELS = { yes: 'Sim', no: 'Não', unknown: 'Não informado' } as const;

export function acceptsPrivateLabel(value: boolean | null): string {
  if (value === null) return ACCEPTS_PRIVATE_LABELS.unknown;
  return value ? ACCEPTS_PRIVATE_LABELS.yes : ACCEPTS_PRIVATE_LABELS.no;
}
