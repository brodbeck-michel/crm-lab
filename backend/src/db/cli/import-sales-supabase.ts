#!/usr/bin/env node
/**
 * CLI: `npm run import:sales-supabase -- --tenant <slug|uuid> --fluxolab <csv> --lovable <csv>
 *        [--dry-run] [--report <arquivo.json>]`
 *
 * Carga pontual das vendas (`public.vendas`) dos dois Supabases do Santé para
 * `sales` do tenant (CRMLAB-45, D-179/D-180). So LE os CSVs exportados — nunca
 * fala com o Supabase, nenhuma credencial aqui. Passo a passo e cuidados de
 * homologacao/producao: docs/guides/MIGRACAO_SANTE.md §1.
 *
 * Nao roda migracao (ao contrario do seed): carga em banco de verdade assume o
 * schema ja migrado pelo job `migrate`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { closeDb, getDb } from '../index.js';
import {
  TenantNotFoundError,
  formatSalesImportReport,
  importSales,
  parseVendasCsv,
  reportToJson,
  resolveTenant,
} from '../../services/sales-supabase-import.service.js';

interface CliArgs {
  tenant: string;
  fluxolab: string;
  lovable: string;
  dryRun: boolean;
  report: string | null;
}

const USAGE =
  'Uso: npm run import:sales-supabase -- --tenant <slug|uuid> --fluxolab <csv> --lovable <csv> ' +
  '[--dry-run] [--report <arquivo.json>]';

function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (['--tenant', '--fluxolab', '--lovable', '--report'].includes(arg)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} precisa de um valor.\n${USAGE}`);
      values.set(arg, value);
      i += 1;
      continue;
    }
    throw new Error(`Argumento desconhecido: ${arg}\n${USAGE}`);
  }
  const need = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`Faltou ${flag}.\n${USAGE}`);
    return value;
  };
  return {
    tenant: need('--tenant'),
    fluxolab: need('--fluxolab'),
    lovable: need('--lovable'),
    dryRun,
    report: values.get('--report') ?? null,
  };
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fluxolab = parseVendasCsv(await readFile(args.fluxolab, 'utf8'), 'fluxolab');
  const lovable = parseVendasCsv(await readFile(args.lovable, 'utf8'), 'lovable');

  const db = await getDb();
  if (db.driver === 'pglite') {
    // Sem DATABASE_URL o backend cai no PGlite em memoria (D-008): banco vazio
    // que some com o processo — carga ali nao faz sentido.
    throw new Error('DATABASE_URL nao definida: a carga precisa do Postgres do ambiente.');
  }
  const tenantId = await resolveTenant(db, args.tenant);
  const report = await importSales(db, {
    tenantId,
    fluxolab,
    lovable,
    dryRun: args.dryRun,
    today: localToday(),
  });

  process.stdout.write(formatSalesImportReport(report));
  if (args.report) {
    await writeFile(args.report, reportToJson(report), 'utf8');
    process.stdout.write(`Relatorio JSON gravado em ${args.report}\n`);
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      err instanceof TenantNotFoundError
        ? `Recusado: ${message}\n`
        : `Falha na carga de vendas: ${message}\n`,
    );
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
