import { describe, expect, it } from 'vitest';
import type { LisDoctorRevenueResponse, LisDoctorRevenueRow } from '@crm-lab/shared';
import { topDoctors } from './executive-report';

function row(name: string, paidValue: number): LisDoctorRevenueRow {
  return {
    doctorKey: `name:${name}`, doctorName: name, council: null, crm: null, uf: null, identified: false,
    doctorId: null, responsibleName: null, requisitionCount: 1, requisitionValue: paidValue, paidCount: 1, paidValue,
  };
}

describe('topDoctors — seção "Médicos Solicitantes" do PDF Executivo (CRMLAB-198, D-336)', () => {
  it('top 10 na ordem do servidor, só quem recebeu algo', () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => row(`M${i}`, 1200 - i * 100)), row('Zero', 0)];
    const doctors: LisDoctorRevenueResponse = {
      period: { startDate: '2026-11-01', endDate: '2026-11-30' },
      rows,
      totals: { requisitionCount: 13, requisitionValue: 0, paidCount: 13, paidValue: 0 },
    };
    const top = topDoctors(doctors);
    expect(top).toHaveLength(10);
    expect(top[0]?.doctorName).toBe('M0');
    expect(top.some((r) => r.doctorName === 'Zero')).toBe(false);
  });

  it('sem dados (ou com filtro de convênio, que manda null) não há seção', () => {
    expect(topDoctors(null)).toEqual([]);
    expect(topDoctors(undefined)).toEqual([]);
  });
});
