/**
 * Formatação pt-BR centralizada — ÚNICO lugar do frontend que formata
 * dinheiro, data e percentual (regra de docs/frontend/COMPONENTS.md).
 *
 * Nenhuma tela deve chamar `toLocaleString` diretamente: se a regra mudar,
 * ela muda aqui e em lugar nenhum mais.
 *
 * Lembrete de contrato (CLAUDE.md §9): dinheiro chega no fio como número
 * decimal (179.80) e datas como ISO 8601 UTC. Formatar é trabalho da view.
 */

/** Variantes de exibição monetária. */
export type MoneyVariant = 'full' | 'compact' | 'thousands';

const BRL_FULL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const BRL_COMPACT = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const DECIMAL_1 = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Formata um valor monetário em pt-BR.
 *
 * - `full`      → `R$ 1.350,00` — sempre com centavos. Padrão.
 * - `compact`   → `R$ 24.400`   — agregados em colunas estreitas, sem centavos.
 * - `thousands` → `R$ 96,4 mil` — escalas grandes em cartões de indicador.
 *
 * `thousands` só encurta a partir de 1.000; abaixo disso cai em `compact`,
 * porque "R$ 0,9 mil" é pior de ler que "R$ 900".
 */
export function formatMoney(value: number, variant: MoneyVariant = 'full'): string {
  if (!Number.isFinite(value)) return BRL_FULL.format(0);

  switch (variant) {
    case 'compact':
      return BRL_COMPACT.format(Math.round(value));

    case 'thousands': {
      const abs = Math.abs(value);
      if (abs < 1000) return BRL_COMPACT.format(Math.round(value));
      if (abs < 1_000_000) return `R$ ${DECIMAL_1.format(value / 1000)} mil`;
      return `R$ ${DECIMAL_1.format(value / 1_000_000)} mi`;
    }

    case 'full':
    default:
      return BRL_FULL.format(value);
  }
}

const INTEGER = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Contagem inteira em pt-BR: `formatCount(1234)` → `1.234`.
 *
 * Existe para que gráfico, indicador e tabela não repitam
 * `toLocaleString('pt-BR')` cada um do seu jeito. Trunca (não arredonda):
 * "1,7 propostas" não é contagem.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return INTEGER.format(0);
  return INTEGER.format(Math.trunc(value));
}

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const DAY_MONTH = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Data relativa curta, para LISTAS (fila de conversas, cartões de proposta).
 *
 * Limites: < 1 min → "agora" · < 1 h → "há N min" · < 24 h → "há N h"
 * · < 48 h → "ontem" · daí em diante → "DD/MM".
 *
 * @param iso data ISO 8601 (UTC)
 * @param now referência de "agora" — injetável para teste
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const diff = now.getTime() - then.getTime();
  if (diff < MINUTE_MS) return 'agora';
  if (diff < HOUR_MS) return `há ${Math.floor(diff / MINUTE_MS)} min`;
  if (diff < DAY_MS) return `há ${Math.floor(diff / HOUR_MS)} h`;
  if (diff < 2 * DAY_MS) return 'ontem';
  return DAY_MONTH.format(then);
}

/**
 * Data e hora absolutas, para DETALHES (modal da proposta, histórico, auditoria).
 * `23/08/2026 14:30`
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // pt-BR devolve "23/08/2026, 14:30" — a vírgula não faz parte do formato pedido.
  return DATE_TIME.format(date).replace(',', '');
}

/**
 * Data SEM hora (`IsoDate`, `YYYY-MM-DD`) → `DD/MM/AAAA`.
 *
 * Reordenação de campos de propósito, sem `new Date()`: `subscriptionUntil`
 * não tem hora, e construir um Date a partir dela traria fuso — em UTC-3 o dia
 * volta um. Usa só os 10 primeiros caracteres, então também aceita um
 * `IsoDateTime` quando a hora é irrelevante.
 */
export function formatIsoDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}

const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = 60 * SECONDS_IN_MINUTE;
const SECONDS_IN_DAY = 24 * SECONDS_IN_HOUR;

/**
 * DURAÇÃO em segundos → texto curto (`1h30`), para tempos de espera.
 *
 * Existe porque `/operations/overview` entrega `waitingSeconds` e
 * `oldestWaitSeconds` já calculados em UTC no SQL (D-021, API_CONTRACTS §7):
 * a tela **formata**, nunca subtrai datas para obter a espera — em UTC-3 a
 * subtração no cliente erra por horas.
 *
 * Faixas: < 1 min → "menos de 1 min" · < 1 h → "N min" · < 24 h → "1h30"
 * (a hora cheia sai como "2h") · daí em diante → "3d 4h" / "3d".
 *
 * Negativo ou não finito devolve "menos de 1 min": relógio do servidor à
 * frente do cálculo não é motivo para exibir "-3 min" numa fila.
 */
export function formatDurationSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < SECONDS_IN_MINUTE) {
    return 'menos de 1 min';
  }

  const seconds = Math.floor(totalSeconds);

  if (seconds < SECONDS_IN_HOUR) {
    return `${Math.floor(seconds / SECONDS_IN_MINUTE)} min`;
  }

  if (seconds < SECONDS_IN_DAY) {
    const hours = Math.floor(seconds / SECONDS_IN_HOUR);
    const minutes = Math.floor((seconds % SECONDS_IN_HOUR) / SECONDS_IN_MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, '0')}`;
  }

  const days = Math.floor(seconds / SECONDS_IN_DAY);
  const hours = Math.floor((seconds % SECONDS_IN_DAY) / SECONDS_IN_HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * Percentual pt-BR. `formatPercent(0.384)` → `38%`; com `fractionDigits: 1` → `38,4%`.
 * Recebe a FRAÇÃO (0–1), não o número já multiplicado.
 */
export function formatPercent(value: number, fractionDigits = 0): string {
  if (!Number.isFinite(value)) return '0%';
  return new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

/**
 * Iniciais para o Avatar: primeira letra do primeiro e do último nome,
 * em caixa alta. Nome único devolve uma letra só; vazio devolve string vazia.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';

  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}
