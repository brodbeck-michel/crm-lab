import { describe, expect, it } from 'vitest';
import { EXAM_IMPORT_COLUMNS } from '@crm-lab/shared';
import { buildExamImportTemplate } from './exam-import-template';

describe('buildExamImportTemplate (CRMLAB-23)', () => {
  it('sai com BOM, separador ; , cabeçalho canônico e uma linha de exemplo', () => {
    const text = buildExamImportTemplate();
    expect(text.startsWith('\uFEFF')).toBe(true);

    const lines = text.slice(1).split('\r\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(EXAM_IMPORT_COLUMNS.join(';'));
    expect(lines[1]?.split(';')).toHaveLength(EXAM_IMPORT_COLUMNS.length);
    expect(lines[1]).toContain('Hemograma completo;HC;');
    expect(lines[1]).toContain('75,00;89,90');
  });
});
