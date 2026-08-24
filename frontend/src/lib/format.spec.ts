import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatRelativeDate,
  initials,
} from './format';

/** Intl pt-BR usa NBSP entre "R$" e o número; normaliza para comparar. */
const norm = (value: string) => value.replace(/[\u00a0\u202f\s]+/g, ' ');

describe('formatMoney', () => {
  it('full: sempre com duas casas', () => {
    expect(norm(formatMoney(1350))).toBe('R$ 1.350,00');
    expect(norm(formatMoney(179.8))).toBe('R$ 179,80');
    expect(norm(formatMoney(0))).toBe('R$ 0,00');
  });

  it('full é o padrão quando a variante é omitida', () => {
    expect(norm(formatMoney(1350))).toBe(norm(formatMoney(1350, 'full')));
  });

  it('compact: sem centavos, arredondado', () => {
    expect(norm(formatMoney(24400, 'compact'))).toBe('R$ 24.400');
    expect(norm(formatMoney(24400.49, 'compact'))).toBe('R$ 24.400');
    expect(norm(formatMoney(24400.5, 'compact'))).toBe('R$ 24.401');
  });

  it('thousands: uma casa decimal e sufixo "mil"', () => {
    expect(norm(formatMoney(96400, 'thousands'))).toBe('R$ 96,4 mil');
    expect(norm(formatMoney(1000, 'thousands'))).toBe('R$ 1,0 mil');
  });

  it('thousands: abaixo de 1.000 cai em compact (não "R$ 0,9 mil")', () => {
    expect(norm(formatMoney(900, 'thousands'))).toBe('R$ 900');
    expect(norm(formatMoney(999, 'thousands'))).toBe('R$ 999');
  });

  it('thousands: a partir de 1 milhão vira "mi"', () => {
    expect(norm(formatMoney(1_250_000, 'thousands'))).toBe('R$ 1,3 mi');
  });

  it('lida com negativos e com valores não finitos', () => {
    expect(norm(formatMoney(-1350))).toBe('-R$ 1.350,00');
    expect(norm(formatMoney(-96400, 'thousands'))).toBe('R$ -96,4 mil');
    expect(norm(formatMoney(Number.NaN))).toBe('R$ 0,00');
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-08-23T14:30:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('menos de um minuto é "agora"', () => {
    expect(formatRelativeDate(ago(0), now)).toBe('agora');
    expect(formatRelativeDate(ago(MIN - 1), now)).toBe('agora');
  });

  it('minutos', () => {
    expect(formatRelativeDate(ago(MIN), now)).toBe('há 1 min');
    expect(formatRelativeDate(ago(4 * MIN), now)).toBe('há 4 min');
    expect(formatRelativeDate(ago(HOUR - 1), now)).toBe('há 59 min');
  });

  it('horas', () => {
    expect(formatRelativeDate(ago(HOUR), now)).toBe('há 1 h');
    expect(formatRelativeDate(ago(2 * HOUR), now)).toBe('há 2 h');
    expect(formatRelativeDate(ago(DAY - 1), now)).toBe('há 23 h');
  });

  it('entre 24h e 48h é "ontem"', () => {
    expect(formatRelativeDate(ago(DAY), now)).toBe('ontem');
    expect(formatRelativeDate(ago(2 * DAY - 1), now)).toBe('ontem');
  });

  it('a partir de 48h vira DD/MM', () => {
    expect(formatRelativeDate('2026-08-12T09:00:00.000Z', now)).toBe('12/08');
  });

  it('data inválida devolve string vazia', () => {
    expect(formatRelativeDate('não é data', now)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('formata DD/MM/YYYY HH:MM sem vírgula', () => {
    // Fixa o fuso pelo offset local para o teste rodar em qualquer máquina.
    const local = new Date(2026, 7, 23, 14, 30, 0);
    expect(formatDateTime(local.toISOString())).toBe('23/08/2026 14:30');
  });

  it('data inválida devolve string vazia', () => {
    expect(formatDateTime('')).toBe('');
  });
});

describe('formatPercent', () => {
  it('recebe fração e devolve inteiro por padrão', () => {
    expect(norm(formatPercent(0.38))).toBe('38%');
    expect(norm(formatPercent(0))).toBe('0%');
    expect(norm(formatPercent(1))).toBe('100%');
  });

  it('respeita casas decimais', () => {
    expect(norm(formatPercent(0.384, 1))).toBe('38,4%');
  });

  it('valor não finito devolve 0%', () => {
    expect(norm(formatPercent(Number.NaN))).toBe('0%');
  });
});

describe('initials', () => {
  it('usa primeiro e último nome', () => {
    expect(initials('Marina Alves')).toBe('MA');
    expect(initials('Ana Paula Souza Lima')).toBe('AL');
  });

  it('nome único devolve uma letra', () => {
    expect(initials('Marina')).toBe('M');
  });

  it('normaliza caixa e espaços extras', () => {
    expect(initials('  marina   alves  ')).toBe('MA');
  });

  it('string vazia devolve vazio', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
  });
});
