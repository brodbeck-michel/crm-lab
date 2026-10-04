import { describe, expect, it } from 'vitest';
import type { Visit } from '@crm-lab/shared';
import { formatDayLabel, weekLabel } from './agenda-dates';
import { HOUR_PX, avatarHue, blockTop, placeVisits } from './agenda-ui';

/** Grade e formatos da Agenda repaginada (CRMLAB-92, D-262). */
function at(day: number, hour: number, minute = 0): Visit {
  return {
    id: `v-${day}-${hour}-${minute}`,
    scheduledAt: new Date(2026, 9, day, hour, minute).toISOString(),
  } as Visit;
}

describe('placeVisits — sobreposição em lanes', () => {
  it('visitas a menos de 1 h uma da outra vão para lanes diferentes; depois de 1 h volta para a primeira', () => {
    const placed = placeVisits([at(6, 9, 30), at(6, 9), at(6, 10), at(6, 9, 45)]);
    expect(placed.map((p) => [p.visit.id, p.lane])).toEqual([
      ['v-6-9-0', 0],
      ['v-6-9-30', 1],
      ['v-6-9-45', 2],
      ['v-6-10-0', 0],
    ]);
  });

  it('o topo é proporcional ao horário e fica preso na faixa 07–20h', () => {
    expect(blockTop(new Date(2026, 9, 6, 9, 30))).toBe(2.5 * HOUR_PX);
    expect(blockTop(new Date(2026, 9, 6, 5, 0))).toBe(0);
    expect(blockTop(new Date(2026, 9, 6, 22, 0))).toBe(13 * HOUR_PX);
  });
});

describe('formatos', () => {
  it('período da semana no mesmo mês e cruzando o mês', () => {
    expect(weekLabel(new Date(2026, 9, 5))).toBe('05 – 11 de out. 2026');
    expect(weekLabel(new Date(2026, 8, 28))).toBe('28 set. – 04 out. 2026');
  });

  it('dia por extenso curto, sem "-feira"', () => {
    expect(formatDayLabel(new Date(2026, 9, 1))).toBe('Quinta, 01 de out.');
    expect(formatDayLabel(new Date(2026, 9, 4))).toBe('Domingo, 04 de out.');
  });

  it('avatar: mesma pessoa, mesmo matiz', () => {
    expect(avatarHue('u-ana')).toBe(avatarHue('u-ana'));
    expect([200, 300, 340, 110, 180]).toContain(avatarHue('u-bia'));
  });
});
