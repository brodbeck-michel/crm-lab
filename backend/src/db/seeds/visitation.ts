/**
 * Seed de dev da Visitacao Medica por carteira (CRMLAB-189, D-329): dois
 * representantes no Lab Vida, cada um com medicos na carteira, uma visita
 * agendada por representante e um medico "sem responsavel" para o filtro de
 * atribuicao do gestor.
 *
 * Roda DEPOIS do resto do tenant e sem o gerador aleatorio do seed, para nao
 * deslocar a sequencia que gera conversas e propostas (o dataset existente fica
 * identico).
 */
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';
import type { DbTx } from '../types.js';
import { seedUuid } from './ids.js';
import { insertUser } from './writers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeedRepresentative {
  key: string;
  email: string;
  name: string;
  doctors: Array<{ key: string; name: string; crm: string; specialty: string; clinic: string }>;
}

/** Representantes do Lab Vida. Senha = a de dev de todo usuario do seed. */
export const LAB_VIDA_REPRESENTATIVES: readonly SeedRepresentative[] = [
  {
    key: 'carla-rep',
    email: 'carla@labvida.com.br',
    name: 'Carla Souza',
    doctors: [
      { key: 'julia', name: 'Dra. Júlia Costa', crm: '12345', specialty: 'Ginecologia', clinic: 'Clínica Vida' },
      { key: 'paulo', name: 'Dr. Paulo Mendes', crm: '23456', specialty: 'Cardiologia', clinic: 'Coração & Cia' },
      { key: 'renata', name: 'Dra. Renata Lima', crm: '34567', specialty: 'Endocrinologia', clinic: 'Endo Sul' },
    ],
  },
  {
    key: 'diego-rep',
    email: 'diego@labvida.com.br',
    name: 'Diego Ramos',
    doctors: [
      { key: 'marcos', name: 'Dr. Marcos Silveira', crm: '45678', specialty: 'Clínica geral', clinic: 'Posto Centro' },
      { key: 'beatriz', name: 'Dra. Beatriz Arruda', crm: '56789', specialty: 'Pediatria', clinic: 'Pequenos Passos' },
    ],
  },
];

export interface SeededRepresentative {
  id: string;
  email: string;
  name: string;
}

async function insertDoctor(
  tx: DbTx,
  input: {
    id: string;
    tenantId: string;
    name: string;
    crm: string | null;
    specialty: string;
    clinic: string;
    responsibleId: string | null;
    createdAt: Date;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO doctors (id, tenant_id, name, crm, crm_uf, specialty, clinic, responsible_user_id,
                          created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      input.id,
      input.tenantId,
      input.name,
      input.crm,
      input.crm !== null ? 'SC' : null,
      input.specialty,
      input.clinic,
      input.responsibleId,
      input.createdAt.toISOString(),
    ],
  );
}

/** Representantes + carteiras + uma visita agendada por representante. */
export async function seedVisitation(
  tx: DbTx,
  input: { tenantId: string; slug: string; now: Date; passwordHash: string },
): Promise<SeededRepresentative[]> {
  const { tenantId, slug, now, passwordHash } = input;
  const createdAt = new Date(now.getTime() - 60 * DAY_MS);
  const seeded: SeededRepresentative[] = [];

  for (const [index, rep] of LAB_VIDA_REPRESENTATIVES.entries()) {
    const userId = seedUuid('dev', 'user', slug, rep.key);
    await insertUser(tx, {
      id: userId,
      tenantId,
      email: rep.email,
      name: rep.name,
      role: 'representative',
      discountLimit: DEFAULT_DISCOUNT_LIMIT.representative,
      passwordHash,
      lastLoginAt: new Date(now.getTime() - (index + 1) * 60 * 60 * 1000),
      createdAt,
    });
    seeded.push({ id: userId, email: rep.email, name: rep.name });

    for (const doctor of rep.doctors) {
      await insertDoctor(tx, {
        id: seedUuid('dev', 'doctor', slug, doctor.key),
        tenantId,
        name: doctor.name,
        crm: doctor.crm,
        specialty: doctor.specialty,
        clinic: doctor.clinic,
        responsibleId: userId,
        createdAt,
      });
    }

    // Uma visita agendada daqui a (2 + i) dias, 10h UTC, com o primeiro medico da carteira.
    const first = rep.doctors[0];
    if (first) {
      const scheduledAt = new Date(now.getTime() + (2 + index) * DAY_MS);
      scheduledAt.setUTCHours(13, 0, 0, 0);
      await tx.query(
        `INSERT INTO doctor_visits (id, tenant_id, doctor_id, responsible_user_id, scheduled_at, type,
                                    agenda, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'presencial', $6, $4, $7, $7)`,
        [
          seedUuid('dev', 'visit', slug, rep.key),
          tenantId,
          seedUuid('dev', 'doctor', slug, first.key),
          userId,
          scheduledAt.toISOString(),
          'Apresentar o painel de check-up',
          createdAt.toISOString(),
        ],
      );
    }
  }

  // Medico antigo sem responsavel: aparece no filtro "Sem responsavel" do gestor.
  await insertDoctor(tx, {
    id: seedUuid('dev', 'doctor', slug, 'sem-responsavel'),
    tenantId,
    name: 'Dr. Henrique Prates',
    crm: null,
    specialty: 'Ortopedia',
    clinic: 'Ortopédica Tubarão',
    responsibleId: null,
    createdAt,
  });

  return seeded;
}
