import { describe, expect, it } from 'vitest';
import type { LisDoctorRevenueRow } from '@crm-lab/shared';
import { buildDoctorRevenueSheet, DOCTOR_REVENUE_EXCEL_HEADER } from './doctor-revenue-report';

const base = { doctorId: null, responsibleName: null, paidCount: 1 };
const ana: LisDoctorRevenueRow = {
  ...base, doctorKey: 'crm:CRM:12345:SC', doctorName: 'Dra. Ana', council: 'CRM', crm: '12345', uf: 'SC',
  identified: true, responsibleName: 'Fátima', requisitionCount: 4, requisitionValue: 800, paidValue: 750,
};
const coringa: LisDoctorRevenueRow = {
  ...base, doctorKey: 'no-doctor', doctorName: null, council: null, crm: null, uf: null,
  identified: false, requisitionCount: 1, requisitionValue: 50, paidValue: 250,
};
const semDados: LisDoctorRevenueRow = { ...coringa, doctorKey: null, paidValue: 0 };

describe('buildDoctorRevenueSheet (CRMLAB-199)', () => {
  it('cabeçalho, linhas na ordem recebida com números e TOTAL', () => {
    const sheet = buildDoctorRevenueSheet([ana, coringa, semDados], {
      requisitionCount: 6, requisitionValue: 900, paidCount: 2, paidValue: 1000,
    });
    expect(sheet[0]).toEqual([...DOCTOR_REVENUE_EXCEL_HEADER]);
    expect(sheet[1]).toEqual(['Dra. Ana', 'CRM', '12345', 'SC', 'Fátima', 4, 800, 750, 75]);
    expect(sheet[2]).toEqual(['Sem médico (CRM 1: sem pedido médico ou enfermagem)', null, null, null, null, 1, 50, 250, 25]);
    expect(sheet[3]?.[0]).toBe('Sem médico informado');
    expect(sheet[4]).toEqual(['TOTAL', null, null, null, null, 6, 900, 1000, 100]);
  });

  it('sem recebido no período, % fica vazio (nunca divisão por zero)', () => {
    const sheet = buildDoctorRevenueSheet([semDados], {
      requisitionCount: 1, requisitionValue: 50, paidCount: 0, paidValue: 0,
    });
    expect(sheet[1]?.[8]).toBeNull();
    expect(sheet[2]?.[8]).toBeNull();
  });
});
