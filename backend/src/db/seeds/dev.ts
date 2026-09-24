/**
 * Dataset de DESENVOLVIMENTO (`npm run seed`).
 *
 * Objetivo: com o banco recem-migrado, toda tela do produto fica apresentavel e
 * todo numero fecha. Nao e ruido aleatorio — e um conjunto com historia:
 *
 *   - 2 laboratorios com TEMAS DIFERENTES (Terracota e Azul Jaleco). Se o tema
 *     de um vazar para o outro, da para ver na hora.
 *   - funil coerente (BUSINESS_RULES §6): conversas > propostas > ganhos, com
 *     taxa de ganho plausivel (~18% das propostas).
 *   - propostas nos 6 estagios (Pipeline sem coluna vazia), com historico legal
 *     segundo `ALLOWED_TRANSITIONS`.
 *   - uma proposta `pending` acima da alcada do atendente + o post em
 *     `#aprovacoes` que a acompanha.
 *   - `perdido` distribuido nos 5 motivos (grafico da tela de Conversao).
 *   - `ganho` com `closed_at` espalhado nas ultimas semanas (curva de receita).
 *   - conversas nao atribuidas e com `unread_count > 0` (chips do inbox).
 *   - `created_at` espalhado no tempo — datas relativas fazem sentido.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_DISCOUNT_LIMIT,
  type ConversationChannel,
  type DistributionMode,
  type LossReason,
  type ProposalStatus,
  type UserRole,
} from '@crm-lab/shared';
import { hashPassword } from '../../lib/password.js';
import type { DbTx } from '../types.js';
import { EXAM_CATALOG, EXAM_CATALOG_SECONDARY, type SeedExam } from './catalog.js';
import { makeRandom, seedUuid } from './ids.js';
import { INSURANCE_SEED } from './insurances.js';
import {
  THEME_AZUL_JALECO,
  THEME_TERRACOTA,
  DEFAULT_FONT_ID,
  DEFAULT_RADIUS_ID,
  type SeedThemePreset,
} from './themes.js';
import {
  insertAuditLog,
  insertChannel,
  insertChannelRead,
  insertConversation,
  insertExam,
  insertInsurance,
  insertInternalMessage,
  insertMessage,
  insertPatient,
  insertProposal,
  insertTenant,
  insertTenantChannel,
  insertTenantSettings,
  insertTheme,
  insertUser,
  type SeedProposalItem,
  type SeedStatusStep,
} from './writers.js';

/** Senha unica e obvia — dev so. O `.env` de producao nunca chega aqui. */
export const DEV_PASSWORD = 'senha123';

export interface DevCredential {
  label: string;
  email: string;
  password: string;
  role: UserRole;
  tenantSlug: string;
}

/** Segredo do webhook sorteado para um laboratorio do seed (D-074/D-076). */
export interface DevWebhookSecret {
  tenantSlug: string;
  secret: string;
}

export interface DevSeedSummary {
  credentials: DevCredential[];
  /** Impresso no resumo: sem isso, ninguem consegue assinar webhook em dev. */
  webhookSecrets: DevWebhookSecret[];
  counts: {
    tenants: number;
    users: number;
    exams: number;
    insurances: number;
    patients: number;
    conversations: number;
    messages: number;
    proposals: number;
    won: number;
    lost: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const PATIENT_NAMES = [
  'Ana Beatriz Souza',
  'Carlos Eduardo Lima',
  'Mariana Costa',
  'Pedro Henrique Alves',
  'Juliana Ferreira',
  'Rafael Moreira',
  'Camila Ribeiro',
  'Bruno Cardoso',
  'Fernanda Rocha',
  'Lucas Martins',
  'Patrícia Gomes',
  'Thiago Barbosa',
  'Larissa Pinheiro',
  'Gustavo Teixeira',
  'Renata Azevedo',
  'Felipe Nogueira',
  'Aline Carvalho',
  'Marcelo Duarte',
  'Vanessa Correia',
  'Diego Fontana',
  'Bianca Moura',
  'Rodrigo Sampaio',
  'Tatiane Vieira',
  'Leonardo Prado',
  'Simone Bastos',
  'André Luiz Farias',
  'Cristiane Lopes',
  'Vinícius Andrade',
  'Débora Mendonça',
  'Otávio Bezerra',
  'Sabrina Peixoto',
  'Henrique Vasconcelos',
  'Priscila Nunes',
  'Eduardo Cavalcanti',
  'Natália Siqueira',
  'Márcio Aguiar',
  'Letícia Brandão',
  'Fábio Guimarães',
  'Isabela Freitas',
  'Roberto Antunes',
] as const;

const CHANNELS: readonly ConversationChannel[] = ['whatsapp', 'whatsapp', 'whatsapp', 'web', 'sms'];

const TAG_POOL = ['convenio', 'particular', 'checkup', 'gestante', 'urgente', 'retorno'] as const;

const PATIENT_OPENERS = [
  'Boa tarde! Gostaria de saber o valor do exame de {exame}, por favor.',
  'Oi, bom dia. Meu médico pediu alguns exames, vocês fazem {exame}?',
  'Olá! Quanto fica {exame} particular?',
  'Boa noite, preciso fazer {exame}. Precisa de agendamento?',
  'Oi! Vocês atendem meu convênio para {exame}?',
  'Bom dia, qual o preparo para {exame}?',
] as const;

const AGENT_REPLIES = [
  'Olá, {paciente}! Tudo bem? Fazemos sim. Vou montar um orçamento com os exames do seu pedido.',
  'Boa tarde, {paciente}! Atendemos sim. O preparo é jejum de 8 horas e o resultado sai em até 24h.',
  'Oi, {paciente}! Podemos atender por convênio ou particular. Prefere qual das duas opções?',
  'Olá, {paciente}! A coleta é de segunda a sexta, das 7h às 11h, sem necessidade de agendamento.',
] as const;

const PATIENT_FOLLOWUPS = [
  'Perfeito, pode mandar o orçamento então.',
  'Consegue um desconto se eu fizer todos de uma vez?',
  'Vou conversar em casa e te retorno, obrigado!',
  'E o resultado sai em quanto tempo?',
  'Tem atendimento no sábado de manhã?',
] as const;

const AGENT_CLOSERS = [
  'Enviei o orçamento aqui pelo chat. Qualquer dúvida é só chamar!',
  'Segue o orçamento com os exames solicitados. Fico à disposição.',
  'Orçamento enviado. Ele fica válido por 15 dias.',
] as const;

const LOSS_SEQUENCE: readonly LossReason[] = [
  'preco',
  'silencio',
  'preco',
  'prazo',
  'exame_indisponivel',
  'silencio',
  'outro',
  'preco',
];

/** Distribuicao pelos 6 estagios — nenhuma coluna do Pipeline fica vazia. */
const STATUS_PLAN: ReadonlyArray<{ status: ProposalStatus; count: number }> = [
  { status: 'novo_contato', count: 5 },
  { status: 'orcamento_enviado', count: 6 },
  { status: 'follow_up', count: 4 },
  { status: 'negociacao', count: 4 },
  { status: 'ganho', count: 6 },
  { status: 'perdido', count: 8 },
];

/** Caminhos legais ate cada estagio (validados contra ALLOWED_TRANSITIONS). */
const PATHS: Readonly<Record<ProposalStatus, ReadonlyArray<readonly ProposalStatus[]>>> = {
  novo_contato: [['novo_contato']],
  orcamento_enviado: [['novo_contato', 'orcamento_enviado']],
  follow_up: [['novo_contato', 'orcamento_enviado', 'follow_up']],
  negociacao: [
    ['novo_contato', 'orcamento_enviado', 'negociacao'],
    ['novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao'],
  ],
  ganho: [
    ['novo_contato', 'orcamento_enviado', 'ganho'],
    ['novo_contato', 'orcamento_enviado', 'negociacao', 'ganho'],
    ['novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao', 'ganho'],
  ],
  perdido: [
    ['novo_contato', 'perdido'],
    ['novo_contato', 'orcamento_enviado', 'perdido'],
    ['novo_contato', 'orcamento_enviado', 'follow_up', 'perdido'],
    ['novo_contato', 'orcamento_enviado', 'negociacao', 'perdido'],
  ],
};

interface TenantPlan {
  slug: string;
  name: string;
  brandName: string;
  theme: SeedThemePreset;
  plan: 'starter' | 'pro' | 'enterprise';
  exams: readonly SeedExam[];
  users: ReadonlyArray<{ key: string; email: string; name: string; role: UserRole }>;
  conversationCount: number;
  /** Multiplicador aplicado ao STATUS_PLAN (o tenant 2 e menor, mas nao vazio). */
  proposalScale: number;
  randomSeed: number;
  /**
   * `undefined` = NENHUMA linha em `tenant_settings`. Linha ausente = defaults
   * (D-065), e esse e o caminho normal em producao: um dos dois laboratorios do
   * dataset fica assim de proposito, para que o caminho apareca em dev.
   */
  distributionMode?: DistributionMode;
}

const TENANT_PLANS: readonly TenantPlan[] = [
  {
    slug: 'lab-vida',
    name: 'Laboratório Vida',
    brandName: 'Lab Vida',
    theme: THEME_TERRACOTA,
    plan: 'pro',
    exams: EXAM_CATALOG,
    users: [
      { key: 'admin', email: 'admin@labvida.com.br', name: 'Helena Duarte', role: 'admin' },
      { key: 'gestor', email: 'gestor@labvida.com.br', name: 'Ricardo Menezes', role: 'manager' },
      { key: 'maria', email: 'maria@labvida.com.br', name: 'Maria Fernandes', role: 'attendant' },
      { key: 'joao', email: 'joao@labvida.com.br', name: 'João Batista', role: 'attendant' },
    ],
    conversationCount: 90,
    proposalScale: 1,
    randomSeed: 20260823,
    /** Lab Vida distribui automaticamente; Lab Central fica no default (D-065). */
    distributionMode: 'round_robin',
  },
  {
    slug: 'lab-central',
    name: 'Laboratório Central',
    brandName: 'Lab Central',
    theme: THEME_AZUL_JALECO,
    plan: 'starter',
    exams: EXAM_CATALOG_SECONDARY,
    users: [
      { key: 'admin', email: 'admin@labcentral.com.br', name: 'Sônia Vasques', role: 'admin' },
      {
        key: 'gestor',
        email: 'gestor@labcentral.com.br',
        name: 'Otávio Ramires',
        role: 'manager',
      },
      {
        key: 'atendente',
        email: 'carla@labcentral.com.br',
        name: 'Carla Bittencourt',
        role: 'attendant',
      },
    ],
    conversationCount: 24,
    proposalScale: 0.35,
    randomSeed: 77713,
  },
];

interface SeededUser {
  id: string;
  key: string;
  name: string;
  role: UserRole;
  discountLimit: number;
}

interface SeededExam {
  id: string;
  exam: SeedExam;
}

/**
 * Segredo de webhook do seed. `DEV_WEBHOOK_SECRET` quando o ambiente define um
 * (util para homologacao com o provedor de verdade); senao, 24 bytes
 * aleatorios POR EXECUCAO. O que ele nunca e: derivado do slug, que e publico.
 */
function devWebhookSecret(): string {
  const configured = process.env.DEV_WEBHOOK_SECRET;
  if (typeof configured === 'string' && configured.trim().length >= 16) {
    return configured.trim();
  }
  return randomBytes(24).toString('hex');
}

export async function seedDevelopment(tx: DbTx, now: Date): Promise<DevSeedSummary> {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const credentials: DevCredential[] = [];
  const webhookSecrets: DevWebhookSecret[] = [];
  const counts: DevSeedSummary['counts'] = {
    tenants: 0,
    users: 0,
    exams: 0,
    insurances: 0,
    patients: 0,
    conversations: 0,
    messages: 0,
    proposals: 0,
    won: 0,
    lost: 0,
  };

  // ---------------------------------------------------------------------------
  // Tenant da PLATAFORMA.
  // `users.tenant_id` e NOT NULL: o schema nao tem usuario "sem tenant". Entao o
  // `platform_operator` mora no seu proprio tenant, que nao guarda dado nenhum
  // de laboratorio (sem exames, conversas ou propostas). E assim que
  // `docs/database/SCHEMA.md` modela o perfil e e o que o console da plataforma
  // espera (ele opera via `withoutTenant`, nunca via RLS do proprio tenant).
  // ---------------------------------------------------------------------------
  const platformTenantId = seedUuid('dev', 'tenant', 'plataforma');
  await insertTenant(tx, {
    id: platformTenantId,
    name: 'Plataforma CRM Lab',
    slug: 'plataforma',
    plan: 'enterprise',
    subscriptionUntil: null,
    createdAt: new Date(now.getTime() - 400 * DAY_MS),
  });
  await insertUser(tx, {
    id: seedUuid('dev', 'user', 'plataforma', 'operador'),
    tenantId: platformTenantId,
    email: 'operador@crmlab.com.br',
    name: 'Operador da Plataforma',
    role: 'platform_operator',
    discountLimit: DEFAULT_DISCOUNT_LIMIT.platform_operator,
    passwordHash,
    lastLoginAt: new Date(now.getTime() - 2 * DAY_MS),
    createdAt: new Date(now.getTime() - 400 * DAY_MS),
  });
  counts.tenants += 1;
  counts.users += 1;
  credentials.push({
    label: 'Operador da plataforma',
    email: 'operador@crmlab.com.br',
    password: DEV_PASSWORD,
    role: 'platform_operator',
    tenantSlug: 'plataforma',
  });

  for (const plan of TENANT_PLANS) {
    const summary = await seedTenant(tx, plan, now, passwordHash);
    counts.tenants += 1;
    counts.users += summary.users;
    counts.exams += summary.exams;
    counts.insurances += summary.insurances;
    counts.patients += summary.patients;
    counts.conversations += summary.conversations;
    counts.messages += summary.messages;
    counts.proposals += summary.proposals;
    counts.won += summary.won;
    counts.lost += summary.lost;
    credentials.push(...summary.credentials);
    webhookSecrets.push(summary.webhookSecret);
  }

  return { credentials, webhookSecrets, counts };
}

interface TenantSummary {
  users: number;
  exams: number;
  insurances: number;
  patients: number;
  conversations: number;
  messages: number;
  proposals: number;
  won: number;
  lost: number;
  credentials: DevCredential[];
  webhookSecret: DevWebhookSecret;
}

async function seedTenant(
  tx: DbTx,
  plan: TenantPlan,
  now: Date,
  passwordHash: string,
): Promise<TenantSummary> {
  const rnd = makeRandom(plan.randomSeed);
  const tenantId = seedUuid('dev', 'tenant', plan.slug);
  const tenantCreatedAt = new Date(now.getTime() - 300 * DAY_MS);

  await insertTenant(tx, {
    id: tenantId,
    name: plan.name,
    slug: plan.slug,
    plan: plan.plan,
    subscriptionUntil: new Date(now.getTime() + 180 * DAY_MS),
    createdAt: tenantCreatedAt,
  });

  await insertTheme(tx, {
    id: seedUuid('dev', 'theme', plan.slug),
    tenantId,
    preset: plan.theme,
    brandName: plan.brandName,
    fontId: DEFAULT_FONT_ID,
    radiusId: DEFAULT_RADIUS_ID,
    createdAt: tenantCreatedAt,
  });

  // ---- usuarios -------------------------------------------------------------
  const users: SeededUser[] = [];
  const credentials: DevCredential[] = [];
  for (const user of plan.users) {
    const id = seedUuid('dev', 'user', plan.slug, user.key);
    const discountLimit = DEFAULT_DISCOUNT_LIMIT[user.role];
    await insertUser(tx, {
      id,
      tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      discountLimit,
      passwordHash,
      lastLoginAt: new Date(now.getTime() - rnd.int(1, 72) * 60 * MIN_MS),
      createdAt: new Date(tenantCreatedAt.getTime() + rnd.int(0, 30) * DAY_MS),
    });
    users.push({ id, key: user.key, name: user.name, role: user.role, discountLimit });
    credentials.push({
      label: `${plan.name} — ${user.name}`,
      email: user.email,
      password: DEV_PASSWORD,
      role: user.role,
      tenantSlug: plan.slug,
    });
  }

  const attendants = users.filter((u) => u.role === 'attendant');
  const manager = users.find((u) => u.role === 'manager') as SeededUser;
  const admin = users.find((u) => u.role === 'admin') as SeededUser;

  // ---- canais internos (onboarding, WORKFLOWS §7) ---------------------------
  const geralId = seedUuid('dev', 'channel', plan.slug, 'geral');
  const aprovacoesId = seedUuid('dev', 'channel', plan.slug, 'aprovacoes');
  await insertChannel(tx, {
    id: geralId,
    tenantId,
    key: 'geral',
    name: '#geral',
    kind: 'channel',
    createdAt: tenantCreatedAt,
  });
  await insertChannel(tx, {
    id: aprovacoesId,
    tenantId,
    key: 'aprovacoes',
    name: '#aprovacoes',
    kind: 'channel',
    createdAt: tenantCreatedAt,
  });

  // ---- canal conectado do laboratorio (D-064) -------------------------------
  // Um por tenant. A tela mostra apenas `apiTokenMasked` e `webhookSecretSet`,
  // nunca o valor em claro.
  //
  // O SEGREDO DO WEBHOOK NAO SAI DO SLUG. Ele era
  // `dev-webhook-secret-${plan.slug}` — computavel por qualquer um que soubesse
  // o slug, que vai na URL PUBLICA do webhook. O `NODE_ENV=production` recusa o
  // seed, mas homologacao/staging rodam com `NODE_ENV=development` e ficavam
  // com um segredo de HMAC adivinhavel, ou seja: escrita em `messages`.
  // Agora ele e sorteado por execucao (ou vem de `DEV_WEBHOOK_SECRET`) e sai
  // impresso no resumo do seed, que e onde o dev ja procura credencial.
  const webhookSecret = devWebhookSecret();
  await insertTenantChannel(tx, {
    id: seedUuid('dev', 'tenant-channel', plan.slug, 'whatsapp'),
    tenantId,
    channel: 'whatsapp',
    displayName: `WhatsApp ${plan.brandName}`,
    phoneNumberId: `dev-phone-id-${plan.slug}`,
    phoneNumber: `+55 48 3333-${plan.slug === 'lab-vida' ? '1001' : '2001'}`,
    apiToken: `dev-token-${plan.slug}-0000`,
    webhookSecret,
    isActive: true,
    connectedAt: new Date(tenantCreatedAt.getTime() + DAY_MS),
    createdAt: tenantCreatedAt,
  });

  // ---- configuracao operacional (D-065) -------------------------------------
  // Sem `distributionMode` no plano => NENHUMA linha. Linha ausente = defaults;
  // manter um dos laboratorios assim faz esse caminho existir em dev.
  if (plan.distributionMode) {
    await insertTenantSettings(tx, {
      tenantId,
      distributionMode: plan.distributionMode,
      greeting: {
        enabled: true,
        message: 'Olá! Recebemos sua mensagem e já vamos te atender. 😊',
      },
      offHours: {
        enabled: true,
        message: 'Nosso atendimento é de segunda a sexta, das 8h às 18h. Retornamos em breve!',
      },
      businessHours: {
        timezone: 'America/Sao_Paulo',
        days: {
          mon: { start: '08:00', end: '18:00' },
          tue: { start: '08:00', end: '18:00' },
          wed: { start: '08:00', end: '18:00' },
          thu: { start: '08:00', end: '18:00' },
          fri: { start: '08:00', end: '17:00' },
          sat: { start: '08:00', end: '12:00' },
          sun: null,
        },
      },
      createdAt: tenantCreatedAt,
    });
  }

  // ---- catalogo -------------------------------------------------------------
  const exams: SeededExam[] = [];
  for (const exam of plan.exams) {
    const id = seedUuid('dev', 'exam', plan.slug, exam.code);
    await insertExam(tx, {
      id,
      tenantId,
      exam,
      createdAt: new Date(tenantCreatedAt.getTime() + DAY_MS),
    });
    exams.push({ id, exam });
  }

  // ---- convênios (Onda 7, D-081/D-082) --------------------------------------
  // Os dois tenants de laboratório ganham o mesmo catálogo de convênios
  // (Apêndice A do spec) — não o tenant de plataforma, que não guarda dado de
  // laboratório nenhum.
  let insuranceCount = 0;
  for (const insurance of INSURANCE_SEED) {
    await insertInsurance(tx, {
      id: seedUuid('dev', 'insurance', plan.slug, insurance.name),
      tenantId,
      name: insurance.name,
      officialName: insurance.officialName ?? null,
      ansCode: insurance.ansCode ?? null,
      type: insurance.type,
      createdAt: new Date(tenantCreatedAt.getTime() + DAY_MS),
    });
    insuranceCount += 1;
  }

  // ---- conversas + mensagens ------------------------------------------------
  interface SeededConversation {
    id: string;
    patientName: string;
    createdAt: Date;
    lastMessageAt: Date;
    assignedTo: SeededUser | null;
  }
  const conversations: SeededConversation[] = [];
  let messageCount = 0;

  /**
   * Cadastro do paciente por telefone (D-059). O Map e o que garante o
   * invariante da tabela — UNIQUE (tenant_id, phone) — mesmo que duas conversas
   * do dataset compartilhem o numero: o segundo encontro REUSA o cadastro, que
   * e exatamente o que `findOrCreateByPhone` faz em producao.
   */
  const patientIdByPhone = new Map<string, string>();
  let patientCount = 0;

  for (let i = 0; i < plan.conversationCount; i += 1) {
    const patientName = PATIENT_NAMES[i % PATIENT_NAMES.length] as string;
    const conversationId = seedUuid('dev', 'conversation', plan.slug, i);
    // ~15% ficam na fila "Não atribuídas" — o chip precisa ter conteudo.
    const unassigned = i % 7 === 3;
    const assignedTo = unassigned ? null : (attendants[i % attendants.length] as SeededUser);
    // Passo 13 é coprimo de 84: as 84 idades distintas saem sem repetir cedo,
    // espalhando `created_at` por ~12 semanas (filtros de período e "há 4 min").
    const ageDays = 1 + ((i * 13) % 84);
    const createdAt = new Date(now.getTime() - ageDays * DAY_MS - rnd.int(0, 600) * MIN_MS);
    const exam = rnd.pick(exams).exam;

    const messages: Array<{
      senderType: 'patient' | 'agent' | 'system';
      senderId: string | null;
      content: string;
      offsetMin: number;
    }> = [];

    messages.push({
      senderType: 'patient',
      senderId: null,
      content: (rnd.pick(PATIENT_OPENERS) as string).replace('{exame}', exam.name),
      offsetMin: 0,
    });

    if (assignedTo) {
      messages.push({
        senderType: 'system',
        senderId: null,
        content: `Conversa atribuída a ${assignedTo.name}.`,
        offsetMin: 3,
      });
      messages.push({
        senderType: 'agent',
        senderId: assignedTo.id,
        content: (rnd.pick(AGENT_REPLIES) as string).replace(
          '{paciente}',
          patientName.split(' ')[0] as string,
        ),
        offsetMin: 6,
      });
      messages.push({
        senderType: 'patient',
        senderId: null,
        content: rnd.pick(PATIENT_FOLLOWUPS) as string,
        offsetMin: 22,
      });
      if (rnd.bool(0.6)) {
        messages.push({
          senderType: 'agent',
          senderId: assignedTo.id,
          content: rnd.pick(AGENT_CLOSERS) as string,
          offsetMin: 31,
        });
      }
    } else {
      messages.push({
        senderType: 'patient',
        senderId: null,
        content: 'Alguém pode me ajudar, por favor?',
        offsetMin: 45,
      });
    }

    const lastOffset = messages[messages.length - 1]?.offsetMin ?? 0;
    const lastMessageAt = new Date(createdAt.getTime() + lastOffset * MIN_MS);
    // Não lidas: toda a fila livre + parte das atribuídas.
    const unreadCount = !assignedTo ? rnd.int(1, 4) : i % 5 === 0 ? rnd.int(1, 3) : 0;

    const patientPhone = `+55489${String(90000000 + i * 137).slice(0, 8)}`;
    const patientEmail = rnd.bool(0.4)
      ? `${patientName.toLowerCase().replace(/[^a-z]+/g, '.')}@email.com`
      : null;

    let patientId = patientIdByPhone.get(patientPhone);
    if (!patientId) {
      patientId = seedUuid('dev', 'patient', plan.slug, patientPhone);
      await insertPatient(tx, {
        id: patientId,
        tenantId,
        phone: patientPhone,
        name: patientName,
        email: patientEmail,
        // Parte do cadastro fica incompleta de proposito: o paciente nasce de um
        // webhook que so conhece o telefone, e a ficha precisa saber exibir isso.
        birthDate: i % 3 === 0 ? `19${70 + (i % 30)}-0${1 + (i % 9)}-1${i % 10}` : null,
        document: i % 4 === 0 ? String(10000000000 + i * 7919).slice(0, 11) : null,
        notes: i % 11 === 0 ? 'Prefere coleta pela manhã. Já fez exames aqui antes.' : null,
        tags: rnd.sample(TAG_POOL, rnd.int(0, 2)),
        createdAt,
      });
      patientIdByPhone.set(patientPhone, patientId);
      patientCount += 1;
    }

    await insertConversation(tx, {
      id: conversationId,
      tenantId,
      patientName,
      patientPhone,
      patientEmail,
      patientId,
      assignedTo: assignedTo?.id ?? null,
      channel: rnd.pick(CHANNELS),
      status: ageDays > 70 ? 'closed' : 'active',
      unreadCount,
      tags: rnd.sample(TAG_POOL, rnd.int(0, 2)),
      lastMessageAt,
      createdAt,
    });

    for (const [index, message] of messages.entries()) {
      const createdMsgAt = new Date(createdAt.getTime() + message.offsetMin * MIN_MS);
      await insertMessage(tx, {
        id: seedUuid('dev', 'message', plan.slug, i, index),
        tenantId,
        conversationId,
        senderType: message.senderType,
        senderId: message.senderId,
        content: message.content,
        messageType: 'text',
        status: message.senderType === 'agent' ? 'read' : 'delivered',
        readAt: unreadCount === 0 ? createdMsgAt : null,
        createdAt: createdMsgAt,
      });
      messageCount += 1;
    }

    conversations.push({
      id: conversationId,
      patientName,
      createdAt,
      lastMessageAt,
      assignedTo,
    });
  }

  // ---- propostas ------------------------------------------------------------
  const plannedStatuses: ProposalStatus[] = [];
  for (const entry of STATUS_PLAN) {
    const count = Math.max(1, Math.round(entry.count * plan.proposalScale));
    for (let i = 0; i < count; i += 1) plannedStatuses.push(entry.status);
  }
  if (plannedStatuses.length >= conversations.length) {
    throw new Error(
      `Tenant ${plan.slug}: ${plannedStatuses.length} propostas para ${conversations.length} ` +
        'conversas — o funil ficaria incoerente (BUSINESS_RULES §6).',
    );
  }

  let won = 0;
  let lost = 0;
  let lossIndex = 0;
  let proposalIndex = 0;
  let pendingProposalId: string | null = null;
  let pendingPatient = '';
  let pendingTotal = 0;

  for (const status of plannedStatuses) {
    // Passo 7 (coprimo de 90 e de 24) espalha as propostas por conversas
    // distintas — nem toda conversa vira proposta, que é o ponto do funil.
    const conversation = conversations[(proposalIndex * 7 + 2) % conversations.length] as {
      id: string;
      patientName: string;
      createdAt: Date;
      assignedTo: SeededUser | null;
    };
    const author =
      conversation.assignedTo ?? (attendants[proposalIndex % attendants.length] as SeededUser);
    const proposalId = seedUuid('dev', 'proposal', plan.slug, proposalIndex);

    // A PRIMEIRA proposta do tenant principal é a que trava em aprovação:
    // atendente (alçada 15%) pedindo 25%.
    const isPendingApproval = plan.proposalScale === 1 && proposalIndex === 0;
    const isRejected = plan.proposalScale === 1 && proposalIndex === 9;

    const discountPercent = isPendingApproval
      ? 25
      : isRejected
        ? 35
        : rnd.bool(0.45)
          ? rnd.pick([5, 10, 12, 15])
          : 0;

    const useInsurancePrice = rnd.bool(0.35);
    const chosen = rnd.sample(exams, rnd.int(2, 5));
    const items: SeedProposalItem[] = chosen.map((entry) => ({
      examId: entry.id,
      examName: entry.exam.name,
      unitPrice: useInsurancePrice ? entry.exam.priceInsurance : entry.exam.pricePrivate,
      quantity: 1,
    }));

    const pathTemplate = rnd.pick(PATHS[status]);
    const path = buildPath(pathTemplate, conversation.createdAt, now, author, manager);
    const createdAt = (path[0] as SeedStatusStep).changedAt;

    const overLimit = discountPercent > author.discountLimit;
    const approvalStatus = isPendingApproval
      ? 'pending'
      : isRejected
        ? 'rejected'
        : overLimit
          ? 'approved'
          : discountPercent > 0
            ? 'approved'
            : 'none';
    const approver = overLimit || isRejected ? manager : author;
    const approvedAt =
      approvalStatus === 'approved' || approvalStatus === 'rejected'
        ? new Date(createdAt.getTime() + 40 * MIN_MS)
        : null;

    const sentAt =
      status === 'novo_contato'
        ? null
        : ((path[1] as SeedStatusStep | undefined)?.changedAt ?? null);

    const reasonLost =
      status === 'perdido'
        ? (LOSS_SEQUENCE[lossIndex++ % LOSS_SEQUENCE.length] as LossReason)
        : null;

    const result = await insertProposal(tx, {
      id: proposalId,
      tenantId,
      proposalNumber: proposalIndex + 1,
      conversationId: conversation.id,
      createdBy: author.id,
      items,
      discountPercent,
      path,
      approvalStatus,
      approvedBy:
        approvalStatus === 'approved' || approvalStatus === 'rejected' ? approver.id : null,
      approvedAt,
      reasonLost,
      sentAt,
      createdAt,
    });

    if (result.status === 'ganho') won += 1;
    if (result.status === 'perdido') lost += 1;

    // ---- auditoria (BUSINESS_RULES §9) --------------------------------------
    await insertAuditLog(tx, {
      id: seedUuid('dev', 'audit', plan.slug, proposalIndex, 'create'),
      tenantId,
      userId: author.id,
      action: 'create_proposal',
      entityType: 'proposal',
      entityId: proposalId,
      oldValues: null,
      newValues: { status: 'novo_contato', discountPercent, totalPrice: result.totalPrice },
      timestamp: createdAt,
    });
    for (let step = 1; step < path.length; step += 1) {
      const from = path[step - 1] as SeedStatusStep;
      const to = path[step] as SeedStatusStep;
      await insertAuditLog(tx, {
        id: seedUuid('dev', 'audit', plan.slug, proposalIndex, 'status', step),
        tenantId,
        userId: to.changedBy,
        action: 'update_proposal_status',
        entityType: 'proposal',
        entityId: proposalId,
        oldValues: { status: from.status },
        newValues:
          to.status === 'perdido' ? { status: to.status, reasonLost } : { status: to.status },
        timestamp: to.changedAt,
      });
    }
    if (approvalStatus === 'approved' && overLimit) {
      await insertAuditLog(tx, {
        id: seedUuid('dev', 'audit', plan.slug, proposalIndex, 'approve'),
        tenantId,
        userId: manager.id,
        action: 'approve_discount',
        entityType: 'proposal',
        entityId: proposalId,
        oldValues: { approvalStatus: 'pending' },
        newValues: { approvalStatus: 'approved', discountPercent },
        timestamp: approvedAt as Date,
      });
    }
    if (approvalStatus === 'rejected') {
      await insertAuditLog(tx, {
        id: seedUuid('dev', 'audit', plan.slug, proposalIndex, 'reject'),
        tenantId,
        userId: manager.id,
        action: 'reject_discount',
        entityType: 'proposal',
        entityId: proposalId,
        oldValues: { approvalStatus: 'pending' },
        newValues: { approvalStatus: 'rejected', reason: 'Desconto acima da margem do exame.' },
        timestamp: approvedAt as Date,
      });
    }

    if (isPendingApproval) {
      pendingProposalId = proposalId;
      pendingPatient = conversation.patientName;
      pendingTotal = result.totalPrice;
    }

    proposalIndex += 1;
  }

  // ---- chat interno ---------------------------------------------------------
  await seedInternalChat(tx, {
    tenantId,
    slug: plan.slug,
    geralId,
    aprovacoesId,
    now,
    admin,
    manager,
    attendants,
    pendingProposalId,
    pendingPatient,
    pendingTotal,
  });

  return {
    users: users.length,
    exams: exams.length,
    insurances: insuranceCount,
    patients: patientCount,
    conversations: conversations.length,
    messages: messageCount,
    proposals: plannedStatuses.length,
    won,
    lost,
    credentials,
    webhookSecret: { tenantSlug: plan.slug, secret: webhookSecret },
  };
}

/**
 * Monta o caminho de estagios com datas coerentes.
 *
 * O relogio ANDA PARA FRENTE a partir da conversa que originou a proposta — uma
 * proposta nunca e mais velha que a propria conversa — e o passo e comprimido
 * para que o ultimo estagio caia sempre antes de `now`. Com as conversas
 * espalhadas por ~12 semanas, os `closed_at` de `ganho` viram serie temporal
 * (curva de receita da tela de Conversao).
 */
function buildPath(
  statuses: readonly ProposalStatus[],
  conversationCreatedAt: Date,
  now: Date,
  author: SeededUser,
  manager: SeededUser,
): SeedStatusStep[] {
  const start = conversationCreatedAt.getTime() + 2 * 60 * MIN_MS;
  const span = Math.max(now.getTime() - start, statuses.length * 60 * MIN_MS);
  const gap = Math.min(4 * DAY_MS, span / (statuses.length + 1));
  return statuses.map((status, i) => ({
    status,
    // A criação é sempre do autor; o fechamento em ganho passa pelo gestor.
    changedBy: i === 0 ? author.id : status === 'ganho' ? manager.id : author.id,
    changedAt: new Date(start + i * gap),
  }));
}

async function seedInternalChat(
  tx: DbTx,
  input: {
    tenantId: string;
    slug: string;
    geralId: string;
    aprovacoesId: string;
    now: Date;
    admin: SeededUser;
    manager: SeededUser;
    attendants: SeededUser[];
    pendingProposalId: string | null;
    pendingPatient: string;
    pendingTotal: number;
  },
): Promise<void> {
  const { tenantId, slug, geralId, aprovacoesId, now } = input;
  const firstAttendant = input.attendants[0] as SeededUser;

  const geral: Array<{ senderId: string | null; content: string; hoursAgo: number }> = [
    {
      senderId: input.admin.id,
      content: 'Bom dia, equipe! Lembrando que a coleta domiciliar começa na segunda.',
      hoursAgo: 30,
    },
    {
      senderId: input.manager.id,
      content: 'Atualizei a tabela de convênio do painel tireoidiano. Confiram antes de orçar.',
      hoursAgo: 26,
    },
    {
      senderId: firstAttendant.id,
      content: 'Anotado! Já ajustei os orçamentos que estavam em aberto.',
      hoursAgo: 25,
    },
  ];

  // ---- estado de leitura (D-068) --------------------------------------------
  // O badge do chat interno so prova alguma coisa se nascer DIFERENTE por
  // usuario. Por isso:
  //   - gestor leu #geral depois do ultimo post          -> #geral zerado
  //   - admin leu #geral ANTES dos posts dos outros dois -> #geral com 2
  //   - ninguem tem linha de #aprovacoes                 -> badge do pedido de
  //     aprovacao aceso para todo mundo (mensagem de sistema conta)
  //   - atendentes nao tem linha nenhuma                 -> tudo nao lido
  await insertChannelRead(tx, {
    tenantId,
    channelId: geralId,
    userId: input.manager.id,
    lastReadAt: new Date(now.getTime() - 60 * MIN_MS),
  });
  await insertChannelRead(tx, {
    tenantId,
    channelId: geralId,
    userId: input.admin.id,
    lastReadAt: new Date(now.getTime() - 27 * 60 * MIN_MS),
  });

  for (const [index, post] of geral.entries()) {
    await insertInternalMessage(tx, {
      id: seedUuid('dev', 'internal-msg', slug, 'geral', index),
      tenantId,
      channelId: geralId,
      senderId: post.senderId,
      content: post.content,
      attachedProposalId: null,
      isSystem: false,
      createdAt: new Date(now.getTime() - post.hoursAgo * 60 * MIN_MS),
    });
  }

  if (!input.pendingProposalId) return;

  const total = input.pendingTotal.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  await insertInternalMessage(tx, {
    id: seedUuid('dev', 'internal-msg', slug, 'aprovacoes', 0),
    tenantId,
    channelId: aprovacoesId,
    senderId: null,
    content:
      `@gestor Pedido de aprovação de desconto: ${input.pendingPatient} - R$ ${total} ` +
      '(25% — acima da alçada de 15%)',
    attachedProposalId: input.pendingProposalId,
    isSystem: true,
    createdAt: new Date(now.getTime() - 3 * 60 * MIN_MS),
  });
  await insertInternalMessage(tx, {
    id: seedUuid('dev', 'internal-msg', slug, 'aprovacoes', 1),
    tenantId,
    channelId: aprovacoesId,
    senderId: firstAttendant.id,
    content: 'Paciente vai fazer o painel completo, por isso pedi os 25%. Consegue olhar?',
    attachedProposalId: null,
    isSystem: false,
    createdAt: new Date(now.getTime() - 2 * 60 * MIN_MS),
  });
}
