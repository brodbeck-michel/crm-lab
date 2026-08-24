/**
 * Ponto de entrada dos seeds. Chamado por `src/db/cli/seed.ts`
 * (`npm run seed` e `npm run seed:e2e`).
 *
 * ------------------------------------------------------------------------
 * POR QUE `withoutTenant()` E NAO `withTenant()`
 * ------------------------------------------------------------------------
 * `withTenant()` exige um `app.tenant_id` que ja exista. O seed **cria** os
 * tenants: no momento da escrita nao ha contexto para setar, e as policies RLS
 * (fail-closed) rejeitariam todo INSERT. Por isso o seed roda inteiro dentro de
 * `db.withoutTenant()`, como dono das tabelas — a mesma excecao auditada que
 * `src/db/types.ts` documenta para login e console da plataforma. Cada linha
 * escrita traz seu `tenant_id` explicito; o teste de FK cruzada em
 * `tests/seeds/` prova que nenhuma linha de um tenant referencia o outro.
 *
 * ------------------------------------------------------------------------
 * IDEMPOTENCIA: LIMPA E RECRIA
 * ------------------------------------------------------------------------
 * A estrategia escolhida e **truncate + recriar**, nao upsert. Motivo: o
 * dataset de dev e um retrato coerente (funil, historico, auditoria); um upsert
 * parcial produziria um retrato meio velho e meio novo — exatamente o tipo de
 * incoerencia que o seed existe para evitar. Rodar `npm run seed` duas vezes
 * deixa o banco identico, sem duplicar nada.
 *
 * Como isso APAGA dados, ha um guarda-corpo: em `NODE_ENV=production` o seed
 * recusa rodar e nao toca em nada.
 */
import { env } from '../../config/env.js';
import { MIGRATIONS_TABLE } from '../migrator.js';
import type { DbClient, DbTx } from '../types.js';
import { seedDevelopment, DEV_PASSWORD, type DevSeedSummary } from './dev.js';
import { seedE2e } from './e2e.js';
import { E2E_PASSWORD, E2E_TENANTS, E2E_USERS } from './e2e-fixtures.js';

export interface RunSeedsOptions {
  /** `npm run seed:e2e` — dataset fixo e deterministico para o Playwright. */
  e2e?: boolean;
  /** Instante de referencia; injetavel para deixar os testes previsiveis. */
  now?: Date;
  /** `false` silencia o resumo (usado pelos testes). */
  print?: boolean;
}

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}

/** Tabelas de dados — tudo menos o controle de migracoes. */
async function dataTables(tx: DbTx): Promise<string[]> {
  const result = await tx.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> $1
     ORDER BY tablename`,
    [MIGRATIONS_TABLE],
  );
  return result.rows.map((row) => row.tablename);
}

async function truncateAll(tx: DbTx): Promise<void> {
  const tables = await dataTables(tx);
  if (tables.length === 0) return;
  // Nomes vem do catalogo do proprio Postgres (nunca de entrada do usuario) e
  // TRUNCATE nao aceita parametro — por isso a interpolacao, entre aspas duplas.
  const quoted = tables.map((name) => `"${name}"`).join(', ');
  await tx.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}

export interface SeedResult {
  mode: 'development' | 'e2e';
  summary: DevSeedSummary | null;
}

export async function runSeeds(db: DbClient, options: RunSeedsOptions = {}): Promise<SeedResult> {
  if (env.isProduction) {
    throw new SeedRefusedError(
      'Seeds recusados: NODE_ENV=production. Este comando APAGA todas as tabelas de dados ' +
        '(truncate + recriar) e só pode rodar em desenvolvimento ou teste.',
    );
  }

  const now = options.now ?? new Date();
  const print = options.print ?? true;
  const mode: SeedResult['mode'] = options.e2e ? 'e2e' : 'development';

  // Excecao auditada: o seed cria os tenants, entao ainda nao existe contexto
  // de tenant para o RLS. Ver o cabecalho deste arquivo.
  const summary = await db.withoutTenant(async (tx) => {
    await truncateAll(tx);
    if (options.e2e) {
      await seedE2e(tx, now);
      return null;
    }
    return seedDevelopment(tx, now);
  });

  if (print) {
    if (summary) printDevSummary(summary);
    else printE2eSummary();
  }

  return { mode, summary };
}

/** Alias exigido pelo CLI (`src/db/cli/seed.ts` procura por `seed`). */
export async function seed(db: DbClient, options: { e2e: boolean }): Promise<void> {
  await runSeeds(db, options);
}

// ---------------------------------------------------------------------------
// Saida no terminal — e o que torna o sistema utilizavel por um humano em
// 5 segundos. Sem `console.log` (CLAUDE.md §10): stdout direto.
// ---------------------------------------------------------------------------

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'admin',
  manager: 'gestor',
  attendant: 'atendente',
  platform_operator: 'operador',
};

function printDevSummary(summary: DevSeedSummary): void {
  const { counts } = summary;
  const winRate = counts.proposals > 0 ? (counts.won / counts.proposals) * 100 : 0;

  line();
  line('  Seed de desenvolvimento aplicado');
  line('  ─────────────────────────────────────────────────────────────');
  line(
    `  ${counts.tenants} tenants · ${counts.users} usuários · ${counts.exams} exames · ` +
      `${counts.conversations} conversas · ${counts.messages} mensagens`,
  );
  line(
    `  ${counts.proposals} propostas · ${counts.won} ganhas · ${counts.lost} perdidas · ` +
      `taxa de ganho ${winRate.toFixed(1)}%`,
  );
  line();
  line('  CREDENCIAIS (senha igual para todos)');
  line('  ─────────────────────────────────────────────────────────────');
  for (const credential of summary.credentials) {
    line(
      `  ${credential.email.padEnd(30)} ${DEV_PASSWORD.padEnd(10)} ` +
        `${(ROLE_LABEL[credential.role] ?? credential.role).padEnd(10)} ${credential.tenantSlug}`,
    );
  }
  line();
  line('  Tenant 1: lab-vida    (tema Terracota & Sálvia)');
  line('  Tenant 2: lab-central (tema Azul Jaleco) — existe para provar isolamento');
  line();
}

function printE2eSummary(): void {
  line();
  line('  Seed E2E aplicado (determinístico)');
  line('  ─────────────────────────────────────────────────────────────');
  line(`  Tenants: ${E2E_TENANTS.alfa.slug} · ${E2E_TENANTS.beta.slug}`);
  line(`  Senha de todos os usuários: ${E2E_PASSWORD}`);
  for (const user of Object.values(E2E_USERS)) {
    line(`  ${user.email.padEnd(30)} ${(ROLE_LABEL[user.role] ?? user.role).padEnd(10)}`);
  }
  line();
  line('  Constantes para o Playwright: backend/src/db/seeds/e2e-fixtures.ts');
  line();
}

export { DEV_PASSWORD } from './dev.js';
export * from './e2e-fixtures.js';
