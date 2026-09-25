/**
 * Parser CSV (RFC 4180) para os exports do Supabase: separador virgula, campos
 * entre aspas com `""` escapando aspas, quebra de linha dentro de aspas, CRLF
 * ou LF e BOM UTF-8 opcional no inicio.
 *
 * Sem dependencia nova de proposito (CRMLAB-45): o formato do export e fixo e
 * pequeno o bastante para caber aqui com teste.
 */

export interface CsvRecord {
  /** Linha (1-based) do arquivo em que o registro COMECA — para o relatorio de rejeitadas. */
  line: number;
  fields: string[];
}

export function parseCsv(text: string): CsvRecord[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;

  const endRecord = (): void => {
    fields.push(field);
    // Linha totalmente vazia (ex.: newline final) nao vira registro.
    if (!(fields.length === 1 && fields[0] === '' && !fieldStarted)) {
      records.push({ line: recordLine, fields });
    }
    fields = [];
    field = '';
    fieldStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      fieldStarted = true;
    } else if (ch === '\r') {
      // CRLF: o \n seguinte fecha o registro; \r solto tambem fecha.
      if (input[i + 1] !== '\n') {
        endRecord();
        line += 1;
        recordLine = line;
      }
    } else if (ch === '\n') {
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) {
    throw new Error(`CSV malformado: aspas abertas a partir da linha ${recordLine}`);
  }
  if (field !== '' || fields.length > 0 || fieldStarted) endRecord();
  return records;
}
