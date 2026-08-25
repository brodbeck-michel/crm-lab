/**
 * O paciente do webhook (D-059 / D-072).
 *
 * Antes desta suite, `conversations.patient_id` so era preenchido pelo backfill
 * da migracao 003: toda conversa criada pelo canal DEPOIS da migracao nascia
 * orfa e o paciente nunca aparecia em `/patients/:id`. Aqui a prova e sempre a
 * mesma — leitura CRUA da linha, sem passar pelo caminho que a criou.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeWebhookModule } from '../../src/controllers/webhook.routes.js';
import { createInMemoryQueue } from '../../src/lib/queue.js';
import {
  MockWhatsAppDriver,
  WhatsAppService,
  signWebhookBody,
} from '../../src/services/whatsapp.service.js';
import { createTenant } from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import { TEST_WEBHOOK_SECRET, testCredentialsResolver } from './fixtures.js';

const SECRET = TEST_WEBHOOK_SECRET;
const WEBHOOK = '/api/v1/webhooks/whatsapp';

function metaPayload(options: {
  phone: string;
  text: string;
  name?: string | null;
  externalId?: string;
}): Record<string, unknown> {
  const contacts =
    options.name === null
      ? [{ wa_id: options.phone }]
      : [{ wa_id: options.phone, profile: { name: options.name ?? 'Joao' } }];
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts,
              messages: [
                {
                  id: options.externalId ?? `wamid.${Math.random().toString(36).slice(2)}`,
                  from: options.phone,
                  timestamp: '1724425200',
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function buildApp(slugToId: Map<string, string>): Promise<TestApp> {
  const db = await getTestDb();
  const whatsapp = new WhatsAppService({
    credentials: testCredentialsResolver(slugToId),
    driver: new MockWhatsAppDriver(),
    queue: createInMemoryQueue({ sleep: async () => undefined }),
  });
  return createTestApp({ db, modules: [makeWebhookModule({ whatsapp })] });
}

interface ConversationRow {
  id: string;
  patient_id: string | null;
  patient_phone: string;
}

interface PatientRow {
  id: string;
  phone: string;
  name: string | null;
  anonymized_at: Date | string | null;
}

/** Leitura CRUA, sem RLS: a prova nao passa pelo caminho que escreveu. */
async function conversationsOf(tenantId: string): Promise<ConversationRow[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<ConversationRow>(
      `SELECT id, patient_id, patient_phone FROM conversations
        WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    ),
  );
  return result.rows;
}

async function patientsOf(tenantId: string): Promise<PatientRow[]> {
  const db = await getTestDb();
  const result = await db.withoutTenant((tx) =>
    tx.query<PatientRow>(
      `SELECT id, phone, name, anonymized_at FROM patients
        WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    ),
  );
  return result.rows;
}

describe('webhook -> conversations.patient_id (D-059)', () => {
  let app: TestApp;
  const slugToId = new Map<string, string>();

  beforeEach(async () => {
    await resetDatabase();
    slugToId.clear();
    app = await buildApp(slugToId);
    app.wsHub.clear();
  });

  const enviar = async (
    slug: string,
    options: { phone: string; text: string; name?: string | null; externalId?: string },
  ): Promise<void> => {
    const body = JSON.stringify(metaPayload(options));
    await app.agent
      .post(`${WEBHOOK}/${slug}`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  };

  it('a conversa nasce ligada ao paciente certo', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    await enviar('lab-vida', { phone: '5511987654321', text: 'Ola', name: 'Joao Santos' });

    const [conversa] = await conversationsOf(tenant.id);
    const pacientes = await patientsOf(tenant.id);

    expect(pacientes).toHaveLength(1);
    expect(pacientes[0]?.phone).toBe('5511987654321');
    expect(pacientes[0]?.name).toBe('Joao Santos');
    // O buraco que esta suite fecha: sem a ligacao isto e `null`.
    expect(conversa?.patient_id).toBe(pacientes[0]?.id);
  });

  it('segunda mensagem do mesmo telefone reusa o MESMO paciente', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    await enviar('lab-vida', { phone: '5511987654321', text: 'primeira', name: 'Joao' });
    await enviar('lab-vida', { phone: '5511987654321', text: 'segunda', name: 'Joao' });
    // Telefone diferente = paciente diferente.
    await enviar('lab-vida', { phone: '5548999111222', text: 'outro', name: 'Maria' });

    const conversas = await conversationsOf(tenant.id);
    const pacientes = await patientsOf(tenant.id);

    expect(conversas).toHaveLength(2);
    expect(pacientes).toHaveLength(2);
    expect(new Set(conversas.map((c) => c.patient_id)).size).toBe(2);
    for (const conversa of conversas) {
      expect(conversa.patient_id).not.toBeNull();
    }
  });

  it('conversa preexistente sem patient_id e religada no proximo contato', async () => {
    const db = await getTestDb();
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    // Simula a base de antes da migracao: conversa sem paciente.
    await db.withoutTenant((tx) =>
      tx.query(
        `INSERT INTO conversations (tenant_id, patient_phone, patient_name, channel, status,
                                    unread_count, last_message_at)
         VALUES ($1, '5511987654321', 'Joao Legado', 'whatsapp', 'active', 0, NOW())`,
        [tenant.id],
      ),
    );
    expect((await conversationsOf(tenant.id))[0]?.patient_id).toBeNull();

    await enviar('lab-vida', { phone: '5511987654321', text: 'voltei', name: 'Joao' });

    const conversas = await conversationsOf(tenant.id);
    const pacientes = await patientsOf(tenant.id);
    expect(conversas).toHaveLength(1);
    expect(pacientes).toHaveLength(1);
    expect(conversas[0]?.patient_id).toBe(pacientes[0]?.id);
  });

  it('nome nulo do canal nao apaga o nome ja cadastrado; nome novo so PREENCHE vazio', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    // 1. primeiro contato sem nome de perfil
    await enviar('lab-vida', { phone: '5511987654321', text: 'oi', name: null });
    expect((await patientsOf(tenant.id))[0]?.name).toBeNull();

    // 2. contato seguinte traz o nome -> preenche o vazio
    await enviar('lab-vida', { phone: '5511987654321', text: 'sou eu', name: 'Joao Santos' });
    expect((await patientsOf(tenant.id))[0]?.name).toBe('Joao Santos');

    // 3. contato sem nome NAO apaga o que ja existe
    await enviar('lab-vida', { phone: '5511987654321', text: 'de novo', name: null });
    expect((await patientsOf(tenant.id))[0]?.name).toBe('Joao Santos');

    // 4. e o apelido do perfil nao sobrescreve o cadastro
    await enviar('lab-vida', { phone: '5511987654321', text: 'ainda eu', name: 'Jhow 🔥' });
    expect((await patientsOf(tenant.id))[0]?.name).toBe('Joao Santos');

    expect(await patientsOf(tenant.id)).toHaveLength(1);
  });

  it('mesmo telefone em dois laboratorios = dois pacientes distintos', async () => {
    const alfa = await createTenant({ slug: 'lab-alfa' });
    const beta = await createTenant({ slug: 'lab-beta' });
    slugToId.set('lab-alfa', alfa.id);
    slugToId.set('lab-beta', beta.id);

    await enviar('lab-alfa', { phone: '5511987654321', text: 'oi alfa', name: 'Joao' });
    await enviar('lab-beta', { phone: '5511987654321', text: 'oi beta', name: 'Joao' });

    const pacientesAlfa = await patientsOf(alfa.id);
    const pacientesBeta = await patientsOf(beta.id);
    expect(pacientesAlfa).toHaveLength(1);
    expect(pacientesBeta).toHaveLength(1);
    expect(pacientesAlfa[0]?.id).not.toBe(pacientesBeta[0]?.id);

    // Nenhuma conversa aponta para o paciente do outro laboratorio.
    const conversasAlfa = await conversationsOf(alfa.id);
    const conversasBeta = await conversationsOf(beta.id);
    expect(conversasAlfa[0]?.patient_id).toBe(pacientesAlfa[0]?.id);
    expect(conversasBeta[0]?.patient_id).toBe(pacientesBeta[0]?.id);
  });

  /**
   * D-072: paciente anonimizado NAO ressuscita. A anonimizacao (D-063) troca o
   * telefone por `anon-<id>`, entao o contato seguinte do numero real cria um
   * cadastro NOVO — a linha antiga fica intocada, sem nome e com
   * `anonymized_at` preenchido.
   */
  it('paciente anonimizado nao e revivido pelo nome do webhook', async () => {
    const db = await getTestDb();
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    await enviar('lab-vida', { phone: '5511987654321', text: 'oi', name: 'Joao Santos' });
    const original = (await patientsOf(tenant.id))[0];
    expect(original?.name).toBe('Joao Santos');

    // Anonimiza pelo mesmo caminho de producao (`PatientRepository.anonymize`).
    const { PatientRepository } = await import('../../src/repositories/patient.repository.js');
    const anonimizado = await new PatientRepository(db).anonymize(tenant.id, original?.id ?? '');
    expect(anonimizado?.changed).toBe(true);
    // A limpeza LGPD so alcanca a conversa porque ela esta LIGADA ao paciente
    // (`WHERE patient_id = $1`): sem a ligacao, o nome continuaria no inbox.
    expect(anonimizado?.conversationsAffected).toBe(1);

    await enviar('lab-vida', { phone: '5511987654321', text: 'voltei', name: 'Joao Santos' });

    const pacientes = await patientsOf(tenant.id);
    expect(pacientes).toHaveLength(2);

    const morto = pacientes.find((p) => p.id === original?.id);
    expect(morto?.name).toBeNull();
    expect(morto?.anonymized_at).not.toBeNull();
    expect(morto?.phone.startsWith('anon-')).toBe(true);

    const novo = pacientes.find((p) => p.id !== original?.id);
    expect(novo?.phone).toBe('5511987654321');
    expect(novo?.anonymized_at).toBeNull();

    // A conversa nova aponta para o cadastro NOVO, nunca para o anonimizado.
    const conversas = await conversationsOf(tenant.id);
    const viva = conversas.find((c) => c.patient_phone === '5511987654321');
    expect(viva?.patient_id).toBe(novo?.id);
  });
});

/**
 * Dado do canal que NAO CABE na coluna.
 *
 * `patients.phone` e VARCHAR(20). Um `from` mais longo virava erro 22001 do
 * Postgres dentro do handler, o `safeHandle` respondia `200 {received:true}` e
 * a mensagem do paciente sumia — o canal considera entregue e nao reentrega.
 * Pior: como o lote inteiro subia junto, as mensagens SEGUINTES, validas,
 * sumiam tambem.
 */
describe('lote com dado que nao cabe na coluna', () => {
  let app: TestApp;
  const slugToId = new Map<string, string>();

  beforeEach(async () => {
    await resetDatabase();
    slugToId.clear();
    app = await buildApp(slugToId);
    app.wsHub.clear();
  });

  /** Um POST com VARIAS mensagens — e assim que a Meta entrega. */
  function lote(messages: Array<{ phone: string; text: string; name?: string }>): string {
    return JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: messages.map((m) => ({
                  wa_id: m.phone,
                  profile: { name: m.name ?? 'Contato' },
                })),
                messages: messages.map((m, index) => ({
                  id: `wamid.lote.${index}`,
                  from: m.phone,
                  type: 'text',
                  text: { body: m.text },
                })),
              },
            },
          ],
        },
      ],
    });
  }

  const enviarLote = async (slug: string, body: string): Promise<void> => {
    await app.agent
      .post(`${WEBHOOK}/${slug}`)
      .set('x-hub-signature-256', signWebhookBody(body, SECRET))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);
  };

  it('a mensagem valida do lote e gravada mesmo com uma invalida antes dela', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    await enviarLote(
      'lab-vida',
      lote([
        // 25 caracteres: nao cabe em VARCHAR(20).
        { phone: '5511987654321000000000000', text: 'nao cabe' },
        { phone: '5511987654321', text: 'esta e valida' },
      ]),
    );

    const pacientes = await patientsOf(tenant.id);
    expect(pacientes.map((p) => p.phone)).toEqual(['5511987654321']);

    const mensagens = await (await getTestDb()).withoutTenant((tx) =>
      tx.query<{ content: string }>(`SELECT content FROM messages WHERE tenant_id = $1`, [
        tenant.id,
      ]),
    );
    // O ponto do teste: a segunda mensagem NAO foi arrastada pela primeira.
    expect(mensagens.rows.map((r) => r.content)).toEqual(['esta e valida']);
  });

  it('nome gigante do perfil e TRUNCADO, nao descartado', async () => {
    const tenant = await createTenant({ slug: 'lab-vida' });
    slugToId.set('lab-vida', tenant.id);

    const apelido = 'J'.repeat(400);
    await enviarLote('lab-vida', lote([{ phone: '5511987654321', text: 'oi', name: apelido }]));

    const pacientes = await patientsOf(tenant.id);
    expect(pacientes).toHaveLength(1);
    expect(pacientes[0]?.name).toHaveLength(255);
  });
});
