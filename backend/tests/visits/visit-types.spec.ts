/**
 * Funções puras de `shared/types/visit.types.ts` usadas pela tela e pelo
 * servidor no registro da visita (CRMLAB-88, D-258).
 */
import { describe, expect, it } from 'vitest';
import {
  isIsoDate,
  isVisitAttachmentMimeType,
  isVisitRecordEditable,
  visitDurationMinutes,
} from '@crm-lab/shared';

describe('visitDurationMinutes', () => {
  it('minutos inteiros, arredondados, do check-in ao check-out', () => {
    expect(
      visitDurationMinutes({ checkInAt: '2026-10-06T13:05:00.000Z', checkOutAt: '2026-10-06T13:50:29.000Z' }),
    ).toBe(45);
    expect(
      visitDurationMinutes({ checkInAt: '2026-10-06T13:05:00.000Z', checkOutAt: '2026-10-06T13:50:30.000Z' }),
    ).toBe(46);
  });

  it('null sem os dois horários', () => {
    expect(visitDurationMinutes({ checkInAt: '2026-10-06T13:05:00.000Z', checkOutAt: null })).toBeNull();
    expect(visitDurationMinutes({ checkInAt: null, checkOutAt: null })).toBeNull();
  });
});

describe('isVisitAttachmentMimeType', () => {
  it('aceita imagem e PDF da allow-list, com sinônimos e parâmetros', () => {
    for (const mime of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'IMAGE/PNG; x=1']) {
      expect(isVisitAttachmentMimeType(mime)).toBe(true);
    }
  });

  it('recusa áudio, vídeo, Office, texto e o que está fora da allow-list', () => {
    for (const mime of ['audio/ogg', 'video/mp4', 'application/msword', 'text/plain', 'image/svg+xml', 'text/html']) {
      expect(isVisitAttachmentMimeType(mime)).toBe(false);
    }
  });
});

describe('isIsoDate', () => {
  it('só AAAA-MM-DD de calendário válido', () => {
    expect(isIsoDate('2026-11-03')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('03/11/2026')).toBe(false);
    expect(isIsoDate('2026-11-03T00:00:00Z')).toBe(false);
  });
});

describe('isVisitRecordEditable', () => {
  it('agendada e realizada sim; cancelada e não recebeu não', () => {
    expect(isVisitRecordEditable('agendada')).toBe(true);
    expect(isVisitRecordEditable('realizada')).toBe(true);
    expect(isVisitRecordEditable('cancelada')).toBe(false);
    expect(isVisitRecordEditable('nao_recebeu')).toBe(false);
  });
});
