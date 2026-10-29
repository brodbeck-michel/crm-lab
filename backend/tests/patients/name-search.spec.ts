/**
 * Busca por PEDAÇO do nome (CRMLAB-125, D-296) — `GET /patients?search=` e
 * `GET /conversations?search=`, mais o índice trigram da migração 061 (D-297).
 *
 * Os casos são os do card: "mar" acha "Maria" e "Marcos", "silv" acha
 * "Silva", sem acento ("jose" -> "José"), sem caixa ("JOAO" -> "João"),
 * palavras em qualquer ordem e TODAS obrigatórias, `%`/`_` literais, quem
 * COMEÇA pelo termo antes de quem só contém. Telefone/CPF seguem iguais e o
 * outro laboratório nunca aparece.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { patientModule } from '../../src/controllers/patient.routes.js';
import type { DbClient } from '../../src/db/types.js';
import {
  escapeLike,
  foldName,
  nameSearchExpression,
  nameSearchWords,
} from '../../src/repositories/name-search.js';
import { createConversation, createTenant, createUser } from '../helpers/factories.js';
import type { TenantRecord, UserRecord } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { createPatient } from './helpers.js';

let db: DbClient;
let app: TestApp;
let tenantA: TenantRecord;
let tenantB: TenantRecord;
let adminA: UserRecord;

beforeAll(async () => {
  db = await getTestDb();
});

beforeEach(async () => {
  await resetDatabase(db);
  app = await createTestApp({ db, modules: [patientModule, conversationModule] });
  tenantA = await createTenant({ name: 'Lab A', slug: 'lab-a', db });
  tenantB = await createTenant({ name: 'Lab B', slug: 'lab-b', db });
  adminA = await createUser({ tenantId: tenantA.id, role: 'admin', db });
});

describe('name-search (funções puras)', () => {
  it('dobra acento e caixa, quebra em palavras e escapa o LIKE', () => {
    expect(foldName('JOÃO Conceição')).toBe('joao conceicao');
    expect(nameSearchWords('  Mar   SÍL ')).toEqual(['mar', 'sil']);
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });

  it('ignora conectivos (de, da, do, das, dos, e, d\') quando há outra palavra', () => {
    expect(nameSearchWords('Maria DE Souza')).toEqual(['maria', 'souza']);
    expect(nameSearchWords("joao e maria d' avila dos santos")).toEqual([
      'joao',
      'maria',
      'avila',
      'santos',
    ]);
    // Só conectivo: continua valendo ("da" acha "Daniela").
    expect(nameSearchWords('da')).toEqual(['da']);
    expect(nameSearchWords('de da')).toEqual(['de', 'da']);
  });

  it('no máximo 6 palavras (contadas depois dos conectivos)', () => {
    expect(nameSearchWords('a de b c d e f g h')).toEqual(['a', 'b', 'c', 'd', 'f', 'g']);
  });
});

describe('GET /patients?search= — pedaço do nome', () => {
  const NAMES = [
    'Maria da Silva',
    'Marcos Pereira',
    'José Conceição',
    'João Souza',
    'Ana Marques',
    'Pedro Lima',
  ];

  beforeEach(async () => {
    for (const [i, name] of NAMES.entries()) {
      await createPatient({
        tenantId: tenantA.id,
        name,
        phone: `+55489991000${String(i).padStart(2, '0')}`,
        db,
      });
    }
    // Mesmo nome no outro laboratório: nunca pode aparecer (RLS/tenant).
    await createPatient({ tenantId: tenantB.id, name: 'Maria da Silva', db });
  });

  async function names(term: string): Promise<string[]> {
    const res = await app.agent
      .get(`/api/v1/patients?search=${encodeURIComponent(term)}&sortBy=name&order=asc`)
      .set(app.auth(adminA))
      .expect(200);
    return res.body.patients.map((p: { name: string }) => p.name);
  }

  it('"mar" acha Maria e Marcos (começo) antes de Ana Marques (outra palavra)', async () => {
    expect(await names('mar')).toEqual(['Marcos Pereira', 'Maria da Silva', 'Ana Marques']);
  });

  it('"Mar" e "MAR" dão o mesmo resultado', async () => {
    expect(await names('Mar')).toEqual(await names('MAR'));
  });

  it('"silv" acha Silva', async () => {
    expect(await names('silv')).toEqual(['Maria da Silva']);
  });

  it('sem acento e sem caixa: "jose", "JOAO", "conceicao"', async () => {
    expect(await names('jose')).toEqual(['José Conceição']);
    expect(await names('JOAO')).toEqual(['João Souza']);
    expect(await names('conceicao')).toEqual(['José Conceição']);
    expect(await names('CONCEIÇÃO')).toEqual(['José Conceição']);
  });

  it('várias palavras em qualquer ordem, todas obrigatórias', async () => {
    expect(await names('maria silva')).toEqual(['Maria da Silva']);
    expect(await names('silva maria')).toEqual(['Maria da Silva']);
    expect(await names('mar sil')).toEqual(['Maria da Silva']);
    expect(await names('maria lima')).toEqual([]);
  });

  it('"maria de souza" acha "Maria Souza" (conectivo ignorado, D-296)', async () => {
    await createPatient({ tenantId: tenantA.id, name: 'Maria Souza', phone: '+5548999100099', db });
    expect(await names('maria de souza')).toEqual(['Maria Souza']);
    expect(await names('maria da silva')).toEqual(['Maria da Silva']);
    // Sozinho, o conectivo vale como pedaço.
    expect(await names('da')).toEqual(['Maria da Silva']);
  });

  it('pedaço do meio da palavra também casa ("arqu" -> Marques)', async () => {
    expect(await names('arqu')).toEqual(['Ana Marques']);
  });

  it('% e _ digitados são literais', async () => {
    expect(await names('%')).toEqual([]);
    expect(await names('m_r')).toEqual([]);
  });

  it('telefone continua por pedaço de dígitos', async () => {
    expect(await names('100003')).toEqual(['João Souza']);
  });

  it('o total do contador bate com a busca', async () => {
    const res = await app.agent
      .get('/api/v1/patients?search=mar&limit=1')
      .set(app.auth(adminA))
      .expect(200);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.patients).toHaveLength(1);
  });
});

describe('GET /conversations?search= — pedaço do nome', () => {
  it('casa pedaço, sem acento, em qualquer ordem; começo antes; só do tenant', async () => {
    const maria = await createConversation({
      tenantId: tenantA.id,
      patientName: 'Maria da Silva',
      patientPhone: '+5548999200001',
      db,
    });
    const marques = await createConversation({
      tenantId: tenantA.id,
      patientName: 'Ana Marques',
      patientPhone: '+5548999200002',
      db,
    });
    const jose = await createConversation({
      tenantId: tenantA.id,
      patientName: 'José Conceição',
      patientPhone: '+5548999200003',
      db,
    });
    await createConversation({
      tenantId: tenantB.id,
      patientName: 'Maria da Silva',
      patientPhone: '+5548999200004',
      db,
    });

    const ids = async (term: string): Promise<string[]> => {
      const res = await app.agent
        .get(`/api/v1/conversations?search=${encodeURIComponent(term)}&sortBy=patientName`)
        .set(app.auth(adminA))
        .expect(200);
      return res.body.conversations.map((c: { id: string }) => c.id);
    };

    // "Ana Marques" vem antes por nome, mas "Maria" COMEÇA por "mar".
    expect(await ids('mar')).toEqual([maria.id, marques.id]);
    expect(await ids('silva maria')).toEqual([maria.id]);
    expect(await ids('JOSE')).toEqual([jose.id]);
    expect(await ids('conceicao')).toEqual([jose.id]);
    // Telefone segue igual.
    expect(await ids('(48) 99920-0003')).toEqual([jose.id]);
  });
});

describe('migração 061 — índice trigram', () => {
  it('cria os índices e o planner os usa quando seq scan está desligado', async () => {
    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('idx_patients_name_trgm', 'idx_conversations_patient_name_trgm')
        ORDER BY indexname`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      'idx_conversations_patient_name_trgm',
      'idx_patients_name_trgm',
    ]);

    // Tabela de teste é minúscula: sem desligar seq scan E index scan o
    // planner (com razão) prefere outro caminho. Bitmap só existe com uma
    // condição indexável — então, se o plano cita o índice trigram, é porque
    // a EXPRESSÃO da consulta (a mesma de `nameSearchExpression`) casa com a
    // do índice. O plano esperado em prod é este Bitmap.
    const explain = (sql: string): Promise<string> =>
      db.transaction(async (tx) => {
        await tx.exec('SET LOCAL enable_seqscan = off');
        await tx.exec('SET LOCAL enable_indexscan = off');
        const res = await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`);
        return res.rows.map((r) => r['QUERY PLAN']).join('\n');
      });
    const plan = await explain(
      `SELECT id FROM patients p WHERE ${nameSearchExpression('p.name')} LIKE '%mar%'`,
    );
    const convPlan = await explain(
      `SELECT id FROM conversations c WHERE ${nameSearchExpression('c.patient_name')} LIKE '%mar%'`,
    );
    expect(convPlan).toContain('idx_conversations_patient_name_trgm');
    expect(plan).toContain('idx_patients_name_trgm');
  });
});
