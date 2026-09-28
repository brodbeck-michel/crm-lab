/**
 * Funcoes puras do reingajamento e dos feriados (CRMLAB-62, D-212/D-213),
 * em `shared/types/reengagement.types.ts`. Relogio sempre explicito.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  REENGAGEMENT_STALE_GRACE_MS,
  easterSunday,
  isHoliday,
  localDateOf,
  nationalHolidays,
  nextOpening,
  planReengagement,
  type BusinessHours,
  type ReengagementRules,
} from '@crm-lab/shared';

const HOUR = 60 * 60 * 1000;
const TZ = 'America/Sao_Paulo';

/** `YYYY-MM-DDTHH:MM` em Brasilia (UTC-3) -> instante. */
function brt(local: string): Date {
  return new Date(`${local}:00.000-03:00`);
}

const WEEKDAYS_8_18: BusinessHours = {
  timezone: TZ,
  days: {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: { start: '08:00', end: '18:00' },
    thu: { start: '08:00', end: '18:00' },
    fri: { start: '08:00', end: '18:00' },
    sat: { start: '08:00', end: '12:00' },
    sun: null,
  },
};

const ALWAYS_OPEN: BusinessHours = { timezone: TZ, days: {} };

function rules(overrides: Partial<{ first: boolean; second: boolean; h1: number; h2: number }> = {}): ReengagementRules {
  const base = DEFAULT_FUNNEL_RULES.reengagement;
  return {
    first: { ...base.first, enabled: overrides.first ?? true, hours: overrides.h1 ?? 1 },
    second: { ...base.second, enabled: overrides.second ?? false, hours: overrides.h2 ?? 24 },
  };
}

const NONE = new Set<string>();

describe('feriados nacionais (D-213)', () => {
  it('Pascoa de 2026 e 2027', () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
  });

  it('2026: fixos + Carnaval seg/ter, Sexta-feira Santa e Corpus Christi', () => {
    expect(nationalHolidays(2026).map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-02-16',
      '2026-02-17',
      '2026-04-03',
      '2026-04-21',
      '2026-05-01',
      '2026-06-04',
      '2026-09-07',
      '2026-10-12',
      '2026-11-02',
      '2026-11-15',
      '2026-11-20',
      '2026-12-25',
    ]);
  });

  it('2027: moveis acompanham a Pascoa', () => {
    const dates = nationalHolidays(2027).map((h) => h.date);
    expect(dates).toEqual(expect.arrayContaining(['2027-02-08', '2027-02-09', '2027-03-26', '2027-05-27']));
    expect(dates).toHaveLength(13);
  });

  it('nacional vem com source national e id nulo', () => {
    const natal = nationalHolidays(2026).find((h) => h.date === '2026-12-25');
    expect(natal).toEqual({ id: null, date: '2026-12-25', description: 'Natal', source: 'national' });
  });

  it('isHoliday: nacional, do laboratorio, e dia comum', () => {
    expect(isHoliday('2026-11-20', NONE)).toBe(true);
    expect(isHoliday('2026-03-19', new Set(['2026-03-19']))).toBe(true);
    expect(isHoliday('2026-03-19', NONE)).toBe(false);
  });

  it('data local usa o fuso do laboratorio, nao UTC', () => {
    // 23:30 de 24/12 em Brasilia ja e 25/12 em UTC.
    expect(localDateOf(brt('2026-12-24T23:30'), TZ)).toBe('2026-12-24');
  });
});

describe('nextOpening (D-212 item 2)', () => {
  it('dentro do horario: sai na hora', () => {
    const due = brt('2026-09-28T10:15');
    expect(nextOpening(due, WEEKDAYS_8_18)).toEqual(due);
  });

  it('antes de abrir: sai na abertura do mesmo dia', () => {
    expect(nextOpening(brt('2026-09-28T06:30'), WEEKDAYS_8_18)).toEqual(brt('2026-09-28T08:00'));
  });

  it('depois de fechar: sai na abertura do dia seguinte', () => {
    expect(nextOpening(brt('2026-09-28T21:00'), WEEKDAYS_8_18)).toEqual(brt('2026-09-29T08:00'));
  });

  it('sabado a tarde com domingo fechado: segunda na abertura', () => {
    expect(nextOpening(brt('2026-10-03T15:00'), WEEKDAYS_8_18)).toEqual(brt('2026-10-05T08:00'));
  });

  it('no horario de fechar em ponto ja e fora', () => {
    expect(nextOpening(brt('2026-09-28T18:00'), WEEKDAYS_8_18)).toEqual(brt('2026-09-29T08:00'));
  });

  it('sem nenhum dia configurado = sempre aberto (D-212 item 1)', () => {
    const due = brt('2026-10-04T03:00');
    expect(nextOpening(due, ALWAYS_OPEN)).toEqual(due);
    expect(nextOpening(due, { timezone: TZ, days: { mon: null, sun: null } })).toEqual(due);
  });
});

describe('planReengagement (D-211/D-212)', () => {
  const anchorAt = brt('2026-09-28T10:00');

  it('regra desligada: nada', () => {
    const action = planReengagement({ anchorAt, first: null, secondDecided: false }, rules({ first: false }), brt('2026-09-28T15:00'), WEEKDAYS_8_18, NONE);
    expect(action).toEqual({ kind: 'none' });
  });

  it('antes das X horas: espera', () => {
    const action = planReengagement({ anchorAt, first: null, secondDecided: false }, rules(), brt('2026-09-28T10:59'), WEEKDAYS_8_18, NONE);
    expect(action.kind).toBe('wait');
  });

  it('venceu dentro do horario: envia o 1º', () => {
    const action = planReengagement({ anchorAt, first: null, secondDecided: false }, rules(), brt('2026-09-28T11:00'), WEEKDAYS_8_18, NONE);
    expect(action).toEqual({ kind: 'send', step: 'first' });
  });

  it('venceu fora do horario: espera a abertura e so entao envia', () => {
    const late = brt('2026-09-28T17:30');
    const r = rules();
    const waiting = planReengagement({ anchorAt: late, first: null, secondDecided: false }, r, brt('2026-09-28T19:00'), WEEKDAYS_8_18, NONE);
    expect(waiting).toEqual({ kind: 'wait', step: 'first', sendAt: brt('2026-09-29T08:00') });
    const opening = planReengagement({ anchorAt: late, first: null, secondDecided: false }, r, brt('2026-09-29T08:05'), WEEKDAYS_8_18, NONE);
    expect(opening).toEqual({ kind: 'send', step: 'first' });
  });

  it('abertura cai em feriado nacional: descarta (nao empurra)', () => {
    // Quinta 19/11 17:30 + 1h -> fora; abertura sexta 20/11 = Consciencia Negra.
    const action = planReengagement(
      { anchorAt: brt('2026-11-19T17:30'), first: null, secondDecided: false },
      rules(),
      brt('2026-11-19T19:00'),
      WEEKDAYS_8_18,
      NONE,
    );
    expect(action).toEqual({ kind: 'discard', step: 'first', reason: 'holiday' });
  });

  it('feriado do laboratorio no proprio dia, dentro do horario: descarta', () => {
    const action = planReengagement({ anchorAt, first: null, secondDecided: false }, rules(), brt('2026-09-28T11:00'), WEEKDAYS_8_18, new Set(['2026-09-28']));
    expect(action).toEqual({ kind: 'discard', step: 'first', reason: 'holiday' });
  });

  it('sempre aberto tambem respeita feriado', () => {
    const action = planReengagement(
      { anchorAt: brt('2026-12-25T09:00'), first: null, secondDecided: false },
      rules(),
      brt('2026-12-25T10:00'),
      ALWAYS_OPEN,
      NONE,
    );
    expect(action).toEqual({ kind: 'discard', step: 'first', reason: 'holiday' });
  });

  it('passou mais de 2h da hora de sair: descarta como stale', () => {
    const now = new Date(brt('2026-09-28T11:00').getTime() + REENGAGEMENT_STALE_GRACE_MS + 60_000);
    const action = planReengagement({ anchorAt, first: null, secondDecided: false }, rules(), now, WEEKDAYS_8_18, NONE);
    expect(action).toEqual({ kind: 'discard', step: 'first', reason: 'stale' });
  });

  it('2º: conta do envio do 1º e so com o 2º ligado', () => {
    const first = { outcome: 'sent' as const, decidedAt: brt('2026-09-28T11:00') };
    const state = { anchorAt, first, secondDecided: false };
    expect(planReengagement(state, rules({ second: false }), brt('2026-09-29T11:00'), WEEKDAYS_8_18, NONE)).toEqual({ kind: 'none' });
    expect(planReengagement(state, rules({ second: true }), brt('2026-09-29T10:59'), WEEKDAYS_8_18, NONE).kind).toBe('wait');
    expect(planReengagement(state, rules({ second: true }), brt('2026-09-29T11:00'), WEEKDAYS_8_18, NONE)).toEqual({ kind: 'send', step: 'second' });
  });

  it('2º nao existe se o 1º foi descartado ou falhou', () => {
    for (const outcome of ['discarded', 'failed'] as const) {
      const state = { anchorAt, first: { outcome, decidedAt: brt('2026-09-28T11:00') }, secondDecided: false };
      expect(planReengagement(state, rules({ second: true }), brt('2026-09-29T12:00'), WEEKDAYS_8_18, NONE)).toEqual({ kind: 'none' });
    }
  });

  it('nunca ha terceiro', () => {
    const state = { anchorAt, first: { outcome: 'sent' as const, decidedAt: brt('2026-09-28T11:00') }, secondDecided: true };
    expect(planReengagement(state, rules({ second: true }), brt('2026-10-05T12:00'), WEEKDAYS_8_18, NONE)).toEqual({ kind: 'none' });
  });

  it('horas mudadas valem na proxima verificacao (recalculado a cada chamada)', () => {
    const now = brt('2026-09-28T11:30');
    expect(planReengagement({ anchorAt, first: null, secondDecided: false }, rules({ h1: 2 }), now, WEEKDAYS_8_18, NONE).kind).toBe('wait');
    expect(planReengagement({ anchorAt, first: null, secondDecided: false }, rules({ h1: 1 }), now, WEEKDAYS_8_18, NONE).kind).toBe('send');
  });
});

describe('fuso fixo sem surpresa', () => {
  it('abertura calculada em Brasilia', () => {
    expect(nextOpening(brt('2026-09-28T07:00'), WEEKDAYS_8_18).getTime() - brt('2026-09-28T07:00').getTime()).toBe(HOUR);
  });
});
