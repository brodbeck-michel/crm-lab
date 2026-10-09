/**
 * Relogio do motor de tempo (CRMLAB-59, D-205 itens 2-3; D-207) — funcoes
 * puras de `@crm-lab/shared`, as mesmas que o front usa.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  describeStageAutomation,
  formatStaleDuration,
  hoursSince,
  minutesSince,
  isDelayElapsed,
  isStaleNewBudget,
  timerDeadline,
} from '@crm-lab/shared';

/** Horario de Brasilia (UTC−3) -> Date. */
function sp(local: string): Date {
  return new Date(`${local}-03:00`);
}

describe('timerDeadline', () => {
  it('corridos: soma dias de 24 h, fim de semana conta', () => {
    expect(timerDeadline(sp('2026-09-25T10:00:00'), 1, 'calendar')).toEqual(sp('2026-09-26T10:00:00'));
  });

  it('úteis: sexta 10h + 1 = segunda 10h', () => {
    expect(timerDeadline(sp('2026-09-25T10:00:00'), 1, 'business')).toEqual(sp('2026-09-28T10:00:00'));
  });

  it('úteis: quinta 10h + 3 = terça 10h', () => {
    expect(timerDeadline(sp('2026-09-24T10:00:00'), 3, 'business')).toEqual(sp('2026-09-29T10:00:00'));
  });

  it('úteis: entrada no sábado começa na segunda 00:00 (sábado 15h + 1 = terça 00:00)', () => {
    expect(timerDeadline(sp('2026-09-26T15:00:00'), 1, 'business')).toEqual(sp('2026-09-29T00:00:00'));
  });

  it('úteis: o fuso é Brasília — sexta 22h em SP (sábado 01h UTC) ainda é sexta', () => {
    expect(timerDeadline(sp('2026-09-25T22:00:00'), 1, 'business')).toEqual(sp('2026-09-28T22:00:00'));
  });

  it('isDelayElapsed vence exatamente no prazo', () => {
    const entered = sp('2026-09-21T10:00:00');
    expect(isDelayElapsed(entered, sp('2026-09-24T09:59:59'), 3, 'calendar')).toBe(false);
    expect(isDelayElapsed(entered, sp('2026-09-24T10:00:00'), 3, 'calendar')).toBe(true);
  });
});

describe('isStaleNewBudget / hoursSince', () => {
  const rule = DEFAULT_FUNNEL_RULES.automation.staleNewBudgetAlert; // 240 min, ligado
  const entered = '2026-09-21T13:00:00.000Z';

  it('só em novo_contato, só com a regra ligada, a partir de N horas corridas', () => {
    expect(isStaleNewBudget('novo_contato', entered, rule, new Date('2026-09-21T16:59:59.000Z'))).toBe(false);
    expect(isStaleNewBudget('novo_contato', entered, rule, new Date('2026-09-21T17:00:00.000Z'))).toBe(true);
    expect(isStaleNewBudget('orcamento_enviado', entered, rule, new Date('2026-09-22T17:00:00.000Z'))).toBe(false);
    expect(isStaleNewBudget('novo_contato', entered, { ...rule, enabled: false }, new Date('2026-09-22T17:00:00.000Z'))).toBe(false);
    expect(isStaleNewBudget('novo_contato', null, rule, new Date('2026-09-22T17:00:00.000Z'))).toBe(false);
  });

  it('hoursSince arredonda para baixo', () => {
    expect(hoursSince(new Date(entered), new Date('2026-09-21T17:59:00.000Z'))).toBe(4);
  });

  it('em minutos: 15 min vence aos 15 min corridos (CRMLAB-97, D-267)', () => {
    const quarter = { enabled: true, minutes: 15 };
    expect(isStaleNewBudget('novo_contato', entered, quarter, new Date('2026-09-21T13:14:59.000Z'))).toBe(false);
    expect(isStaleNewBudget('novo_contato', entered, quarter, new Date('2026-09-21T13:15:00.000Z'))).toBe(true);
  });

  it('minutesSince arredonda para baixo; formatStaleDuration troca min por h a partir de 1 h', () => {
    expect(minutesSince(new Date(entered), new Date('2026-09-21T13:17:59.000Z'))).toBe(17);
    expect(formatStaleDuration(0)).toBe('0 min');
    expect(formatStaleDuration(59)).toBe('59 min');
    expect(formatStaleDuration(60)).toBe('1 h');
    expect(formatStaleDuration(299)).toBe('4 h');
  });
});

describe('describeStageAutomation', () => {
  it('monta o texto do histórico', () => {
    expect(describeStageAutomation({ rule: 'sentToFollowUp', days: 3, dayCounting: 'calendar' })).toBe('Enviado há 3 dias');
    expect(describeStageAutomation({ rule: 'negotiationToFollowUp', days: 1, dayCounting: 'business' })).toBe(
      'Negociação sem pagamento há 1 dia útil',
    );
    expect(describeStageAutomation({ rule: 'followUpToLost', days: 15, dayCounting: 'business' })).toBe(
      'Follow-up há 15 dias úteis (Silêncio)',
    );
  });
});
