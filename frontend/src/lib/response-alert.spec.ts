import { describe, expect, it } from 'vitest';
import {
  BUSINESS_CALENDAR_LOOKBACK_DAYS,
  businessMinutesBetween,
  responseAlertMinutes,
  type BusinessHours,
  type ResponseAlertCalendar,
} from '@crm-lab/shared';

/**
 * Minutos úteis do alerta de tempo de resposta (CRMLAB-84, D-254) — funções
 * puras de `@crm-lab/shared` que a lista de conversas usa no navegador.
 * São Paulo é UTC-3 o ano todo (sem horário de verão desde 2019).
 */

const WEEKDAYS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  days: {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: { start: '08:00', end: '18:00' },
    thu: { start: '08:00', end: '18:00' },
    fri: { start: '08:00', end: '18:00' },
    sat: null,
  },
};
const ALWAYS_OPEN: BusinessHours = { timezone: 'America/Sao_Paulo', days: {} };
const NONE = new Set<string>();

/** Hora local de São Paulo → instante. */
function sp(local: string): Date {
  return new Date(`${local}-03:00`);
}

describe('businessMinutesBetween', () => {
  it('dentro do expediente conta o relógio', () => {
    // 2026-10-01 é quinta-feira.
    expect(businessMinutesBetween(sp('2026-10-01T10:00'), sp('2026-10-01T10:23'), WEEKDAYS, NONE)).toBe(23);
  });

  it('antes de abrir não conta', () => {
    expect(businessMinutesBetween(sp('2026-10-01T07:00'), sp('2026-10-01T08:30'), WEEKDAYS, NONE)).toBe(30);
  });

  it('a noite fica de fora', () => {
    expect(businessMinutesBetween(sp('2026-10-01T17:50'), sp('2026-10-02T08:10'), WEEKDAYS, NONE)).toBe(20);
  });

  it('o fim de semana fica de fora', () => {
    // Sexta 17:55 → segunda 08:05.
    expect(businessMinutesBetween(sp('2026-10-02T17:55'), sp('2026-10-05T08:05'), WEEKDAYS, NONE)).toBe(10);
  });

  it('feriado nacional fica de fora (12/10/2026, segunda)', () => {
    expect(businessMinutesBetween(sp('2026-10-09T17:50'), sp('2026-10-13T08:10'), WEEKDAYS, NONE)).toBe(20);
  });

  it('feriado do laboratório fica de fora', () => {
    const custom = new Set(['2026-10-02']);
    expect(businessMinutesBetween(sp('2026-10-01T17:50'), sp('2026-10-02T08:10'), WEEKDAYS, custom)).toBe(10);
    expect(businessMinutesBetween(sp('2026-10-01T17:50'), sp('2026-10-05T08:10'), WEEKDAYS, custom)).toBe(20);
  });

  it('sem expediente configurado é sempre aberto, menos feriado', () => {
    expect(businessMinutesBetween(sp('2026-10-01T10:00'), sp('2026-10-01T10:45'), ALWAYS_OPEN, NONE)).toBe(45);
    // 11/10 23:00 → 13/10 01:00: o dia 12 inteiro sai.
    expect(businessMinutesBetween(sp('2026-10-11T23:00'), sp('2026-10-13T01:00'), ALWAYS_OPEN, NONE)).toBe(120);
  });

  it('intervalo vazio ou invertido é zero', () => {
    const at = sp('2026-10-01T10:00');
    expect(businessMinutesBetween(at, at, WEEKDAYS, NONE)).toBe(0);
    expect(businessMinutesBetween(at, sp('2026-10-01T09:00'), WEEKDAYS, NONE)).toBe(0);
  });
});

describe('responseAlertMinutes', () => {
  const calendar: ResponseAlertCalendar = { businessHours: WEEKDAYS, customHolidays: NONE };
  const rule = { enabled: true, minutes: 15 };
  const now = sp('2026-10-01T10:20');
  const waiting = { status: 'active' as const, awaitingReplySince: sp('2026-10-01T10:00').toISOString() };

  it('a partir do limite devolve os minutos úteis', () => {
    expect(responseAlertMinutes(waiting, rule, calendar, now)).toBe(20);
    expect(responseAlertMinutes(waiting, { enabled: true, minutes: 20 }, calendar, now)).toBe(20);
  });

  it('abaixo do limite, regra desligada, encerrada ou sem espera: null', () => {
    expect(responseAlertMinutes(waiting, { enabled: true, minutes: 21 }, calendar, now)).toBeNull();
    expect(responseAlertMinutes(waiting, { enabled: false, minutes: 15 }, calendar, now)).toBeNull();
    expect(responseAlertMinutes({ ...waiting, status: 'closed' }, rule, calendar, now)).toBeNull();
    expect(responseAlertMinutes({ status: 'active', awaitingReplySince: null }, rule, calendar, now)).toBeNull();
    expect(responseAlertMinutes({ status: 'active' }, rule, calendar, now)).toBeNull();
  });

  it('fora do expediente o relógio para: escreveu às 17:55, às 08:05 do dia seguinte são 10 min', () => {
    const late = { status: 'active' as const, awaitingReplySince: sp('2026-10-01T17:55').toISOString() };
    expect(responseAlertMinutes(late, { enabled: true, minutes: 10 }, calendar, sp('2026-10-02T08:05'))).toBe(10);
    expect(responseAlertMinutes(late, rule, calendar, sp('2026-10-02T08:05'))).toBeNull();
  });

  it(`espera muito antiga conta só os últimos ${BUSINESS_CALENDAR_LOOKBACK_DAYS} dias`, () => {
    const old = { status: 'active' as const, awaitingReplySince: '2026-07-01T12:00:00.000Z' };
    const always: ResponseAlertCalendar = { businessHours: ALWAYS_OPEN, customHolidays: NONE };
    // Janela 26/09–10/10/2026 sem feriado nacional.
    expect(responseAlertMinutes(old, rule, always, new Date('2026-10-10T12:00:00Z'))).toBe(
      BUSINESS_CALENDAR_LOOKBACK_DAYS * 24 * 60,
    );
  });
});
