/**
 * Constantes do dataset E2E (`npm run seed:e2e`).
 *
 * ESTE MODULO E DE PROPOSITO LIVRE DE DEPENDENCIAS DE RUNTIME: so `import type`.
 * O Playwright (`e2e/`) importa daqui em vez de repetir strings soltas nos specs:
 *
 *   import { E2E_USERS, E2E_TENANTS, E2E_PROPOSALS }
 *     from '../backend/src/db/seeds/e2e-fixtures.js';
 *
 * Tudo aqui e FIXO: IDs, e-mails, senhas, precos e totais nao mudam entre
 * execucoes. `tests/seeds/e2e-seed.spec.ts` prova que o banco semeado bate com
 * estas constantes — inclusive que cada `expectedTotal` e igual a
 * `calculateTotal(items, discountPercent)` de `@crm-lab/shared` (BR §1).
 */
import type {
  BusinessHours,
  ConversationChannel,
  DistributionMode,
  InsuranceType,
  LossReason,
  ProposalStatus,
  UserRole,
} from '@crm-lab/shared';

/** Senha unica de todos os usuarios e2e — o Playwright nao precisa de mais nada. */
export const E2E_PASSWORD = 'E2e#Senha2026';

export interface E2eTenant {
  id: string;
  name: string;
  slug: string;
  /** Nome do preset de `docs/design/DESIGN_TOKENS.md` aplicado ao tenant. */
  themeName: string;
  /** Cor de acento esperada apos o login (cenario "Personalização"). */
  accent: string;
}

/** Dois tenants: o cenario "Isolamento" de TESTING.md exige exatamente isso. */
export const E2E_TENANTS = {
  alfa: {
    id: 'a0000000-0000-4000-8000-000000000001',
    name: 'Laboratório E2E Alfa',
    slug: 'e2e-alfa',
    themeName: 'Terracota & Sálvia',
    accent: '#c67139',
  },
  beta: {
    id: 'b0000000-0000-4000-8000-000000000001',
    name: 'Laboratório E2E Beta',
    slug: 'e2e-beta',
    themeName: 'Azul Jaleco',
    accent: '#2f6f9f',
  },
} as const satisfies Record<string, E2eTenant>;

export interface E2eUser {
  id: string;
  tenantId: string;
  email: string;
  password: string;
  name: string;
  role: UserRole;
  discountLimit: number;
}

export const E2E_USERS = {
  /** Admin do tenant Alfa — cenario "Personalização" (troca de tema). */
  alfaAdmin: {
    id: 'a0000000-0000-4000-8000-000000000101',
    tenantId: E2E_TENANTS.alfa.id,
    email: 'admin@e2e-alfa.com.br',
    password: E2E_PASSWORD,
    name: 'Alice Admin',
    role: 'admin',
    discountLimit: 100,
  },
  /** Gestor do tenant Alfa — aprova o desconto de 25% em #aprovacoes. */
  alfaManager: {
    id: 'a0000000-0000-4000-8000-000000000102',
    tenantId: E2E_TENANTS.alfa.id,
    email: 'gestor@e2e-alfa.com.br',
    password: E2E_PASSWORD,
    name: 'Gustavo Gestor',
    role: 'manager',
    discountLimit: 30,
  },
  /** Atendente do tenant Alfa — dono das conversas e criador dos orcamentos. */
  alfaAttendant: {
    id: 'a0000000-0000-4000-8000-000000000103',
    tenantId: E2E_TENANTS.alfa.id,
    email: 'atendente@e2e-alfa.com.br',
    password: E2E_PASSWORD,
    name: 'Ana Atendente',
    role: 'attendant',
    discountLimit: 15,
  },
  /** Atendente do tenant Beta — o lado "de fora" do teste de isolamento. */
  betaAttendant: {
    id: 'b0000000-0000-4000-8000-000000000103',
    tenantId: E2E_TENANTS.beta.id,
    email: 'atendente@e2e-beta.com.br',
    password: E2E_PASSWORD,
    name: 'Bruno Atendente',
    role: 'attendant',
    discountLimit: 15,
  },
} as const satisfies Record<string, E2eUser>;

export interface E2eExam {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  pricePrivate: number;
  priceInsurance: number;
}

/** Catalogo minimo e fixo do tenant Alfa (o cenario "Orçamento" usa os 2 primeiros). */
export const E2E_EXAMS = {
  hemograma: {
    id: 'a0000000-0000-4000-8000-000000000201',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'HEM001',
    name: 'Hemograma completo',
    pricePrivate: 38.0,
    priceInsurance: 21.5,
  },
  glicose: {
    id: 'a0000000-0000-4000-8000-000000000202',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'BIO001',
    name: 'Glicose em jejum',
    pricePrivate: 22.0,
    priceInsurance: 12.5,
  },
  tsh: {
    id: 'a0000000-0000-4000-8000-000000000203',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'HOR001',
    name: 'TSH - Hormônio tireoestimulante',
    pricePrivate: 48.0,
    priceInsurance: 27.0,
  },
  vitaminaD: {
    id: 'a0000000-0000-4000-8000-000000000204',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'VIT001',
    name: 'Vitamina D - 25-hidroxivitamina D',
    pricePrivate: 98.0,
    priceInsurance: 54.0,
  },
  colesterol: {
    id: 'a0000000-0000-4000-8000-000000000205',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'BIO005',
    name: 'Colesterol total',
    pricePrivate: 24.0,
    priceInsurance: 13.5,
  },
  triglicerides: {
    id: 'a0000000-0000-4000-8000-000000000206',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'BIO009',
    name: 'Triglicerídeos',
    pricePrivate: 26.0,
    priceInsurance: 14.5,
  },
  psa: {
    id: 'a0000000-0000-4000-8000-000000000207',
    tenantId: E2E_TENANTS.alfa.id,
    code: 'MAR001',
    name: 'PSA total - Antígeno prostático específico',
    pricePrivate: 72.0,
    priceInsurance: 40.0,
  },
} as const satisfies Record<string, E2eExam>;

/** O tenant Beta tem catalogo proprio — nenhum ID em comum com o Alfa. */
export const E2E_EXAMS_BETA = {
  hemograma: {
    id: 'b0000000-0000-4000-8000-000000000201',
    tenantId: E2E_TENANTS.beta.id,
    code: 'HEM001',
    name: 'Hemograma completo',
    pricePrivate: 41.0,
    priceInsurance: 23.0,
  },
  glicose: {
    id: 'b0000000-0000-4000-8000-000000000202',
    tenantId: E2E_TENANTS.beta.id,
    code: 'BIO001',
    name: 'Glicose em jejum',
    pricePrivate: 25.0,
    priceInsurance: 14.0,
  },
} as const satisfies Record<string, E2eExam>;

/**
 * Convênio do tenant Alfa (Onda 7, D-081/D-082). Só o Alfa ganha convênio —
 * o Beta fica sem, para que o cenário "Isolamento" também cubra `/insurances`.
 *
 * "Particular" NÃO é uma fixture desta tabela: é `insuranceId: null|ausente`
 * no `POST /proposals` — nenhuma constante representa isso porque não há
 * linha nenhuma para representar (D-082).
 */
export interface E2eInsurance {
  id: string;
  tenantId: string;
  name: string;
  officialName: string | null;
  ansCode: string | null;
  type: InsuranceType;
}

export const E2E_INSURANCES = {
  unimedTubarao: {
    id: 'a0000000-0000-4000-8000-000000000701',
    tenantId: E2E_TENANTS.alfa.id,
    name: 'Unimed Tubarão',
    officialName: 'Unimed de Tubarão Cooperativa de Trabalho Médico',
    ansCode: '364860',
    type: 'cooperativa',
  },
} as const satisfies Record<string, E2eInsurance>;

/**
 * Preço por (exame, convênio) — só 2 linhas, de propósito (D-081, spec §3.6):
 * o suficiente para o teste de resolução de preço (`hemograma` tem preço
 * cadastrado para a Unimed Tubarão) e o teste de fallback (qualquer outro
 * exame de `E2E_EXAMS`, ex. `glicose`, NÃO tem linha aqui — cai em
 * `pricePrivate` com `priceSource: 'private'`, mesmo numa proposta com
 * convênio escolhido).
 */
export interface E2eExamPrice {
  examId: string;
  insuranceId: string;
  price: number;
}

export const E2E_EXAM_PRICES = [
  { examId: E2E_EXAMS.hemograma.id, insuranceId: E2E_INSURANCES.unimedTubarao.id, price: 32.0 },
  { examId: E2E_EXAMS.tsh.id, insuranceId: E2E_INSURANCES.unimedTubarao.id, price: 40.0 },
] as const satisfies readonly E2eExamPrice[];

/**
 * Cadastro do paciente (D-059). O telefone e a identidade dentro do tenant:
 * `UNIQUE (tenant_id, phone)`. A conversa aponta para o cadastro por `patientId`
 * e continua carregando as copias denormalizadas (passo 1 da regra dos 3 passos).
 */
export interface E2ePatient {
  id: string;
  tenantId: string;
  phone: string;
  name: string;
  email: string | null;
  /** 'YYYY-MM-DD' ou `null` — o paciente nasce de um webhook que so sabe o telefone. */
  birthDate: string | null;
  /** CPF, so digitos. `null` e o caso normal. */
  document: string | null;
  notes: string | null;
  tags: readonly string[];
}

export const E2E_PATIENTS = {
  /** Ficha completa — o cenario "Paciente" abre esta e edita o cadastro. */
  carla: {
    id: 'a0000000-0000-4000-8000-000000000501',
    tenantId: E2E_TENANTS.alfa.id,
    phone: '+5548999110001',
    name: 'Carla Pereira',
    email: 'carla.pereira@email.com',
    birthDate: '1985-04-12',
    document: '12345678901',
    notes: 'Prefere coleta pela manhã.',
    tags: ['particular'],
  },
  /** Cadastro minimo: so telefone e nome, como sai do webhook. */
  marcos: {
    id: 'a0000000-0000-4000-8000-000000000502',
    tenantId: E2E_TENANTS.alfa.id,
    phone: '+5548999110002',
    name: 'Marcos Antunes',
    email: null,
    birthDate: null,
    document: null,
    notes: null,
    tags: [],
  },
  juliana: {
    id: 'a0000000-0000-4000-8000-000000000503',
    tenantId: E2E_TENANTS.alfa.id,
    phone: '+5548999110003',
    name: 'Juliana Prado',
    email: 'juliana.prado@email.com',
    birthDate: '1992-11-30',
    document: null,
    notes: null,
    tags: ['convenio'],
  },
  rafael: {
    id: 'a0000000-0000-4000-8000-000000000504',
    tenantId: E2E_TENANTS.alfa.id,
    phone: '+5548999110004',
    name: 'Rafael Nunes',
    email: null,
    birthDate: null,
    document: null,
    notes: null,
    tags: [],
  },
  /**
   * Cenario "Isolamento": se `/patients` do Alfa devolver esta linha — ou se o
   * nome/telefone/anotacao aparecerem em qualquer tela do Alfa — o isolamento
   * vazou. O telefone e proposital e deliberadamente DIFERENTE dos do Alfa: o
   * spec de isolamento usa a string como "nao pode aparecer", e um telefone
   * compartilhado (legitimo entre tenants) tornaria essa asserção ambigua.
   */
  betaSecreto: {
    id: 'b0000000-0000-4000-8000-000000000501',
    tenantId: E2E_TENANTS.beta.id,
    phone: '+5551988220001',
    name: 'Paciente Confidencial Beta',
    email: null,
    birthDate: null,
    document: null,
    notes: 'Anotação interna do Beta — nunca pode aparecer no Alfa.',
    tags: [],
  },
} as const satisfies Record<string, E2ePatient>;

export interface E2eConversation {
  id: string;
  tenantId: string;
  /** Cadastro correspondente (D-059). */
  patientId: string;
  patientName: string;
  patientPhone: string;
  /** `null` = fila "Não atribuídas". */
  assignedTo: string | null;
  unreadCount: number;
}

export const E2E_CONVERSATIONS = {
  /** Cenario "Atendimento" e "Orçamento": atribuida a Ana. */
  atribuida: {
    id: 'a0000000-0000-4000-8000-000000000301',
    tenantId: E2E_TENANTS.alfa.id,
    patientId: E2E_PATIENTS.carla.id,
    patientName: E2E_PATIENTS.carla.name,
    patientPhone: E2E_PATIENTS.carla.phone,
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 0,
  },
  /** Cenario "Atendimento": chip "Não atribuídas" precisa de conteudo. */
  naoAtribuida: {
    id: 'a0000000-0000-4000-8000-000000000302',
    tenantId: E2E_TENANTS.alfa.id,
    patientId: E2E_PATIENTS.marcos.id,
    patientName: E2E_PATIENTS.marcos.name,
    patientPhone: E2E_PATIENTS.marcos.phone,
    assignedTo: null,
    unreadCount: 3,
  },
  /** Cenario "Aprovação": conversa da proposta com 25% de desconto. */
  aprovacao: {
    id: 'a0000000-0000-4000-8000-000000000303',
    tenantId: E2E_TENANTS.alfa.id,
    patientId: E2E_PATIENTS.juliana.id,
    patientName: E2E_PATIENTS.juliana.name,
    patientPhone: E2E_PATIENTS.juliana.phone,
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 1,
  },
  /** Cenario "Pipeline": conversa da proposta em negociacao. */
  pipeline: {
    id: 'a0000000-0000-4000-8000-000000000304',
    tenantId: E2E_TENANTS.alfa.id,
    patientId: E2E_PATIENTS.rafael.id,
    patientName: E2E_PATIENTS.rafael.name,
    patientPhone: E2E_PATIENTS.rafael.phone,
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 0,
  },
  /** Cenario "Isolamento": NADA disto pode aparecer para um usuario do Alfa. */
  betaSecreta: {
    id: 'b0000000-0000-4000-8000-000000000301',
    tenantId: E2E_TENANTS.beta.id,
    patientId: E2E_PATIENTS.betaSecreto.id,
    patientName: E2E_PATIENTS.betaSecreto.name,
    patientPhone: E2E_PATIENTS.betaSecreto.phone,
    assignedTo: E2E_USERS.betaAttendant.id,
    unreadCount: 2,
  },
} as const satisfies Record<string, E2eConversation>;

export interface E2eProposalItem {
  examId: string;
  examName: string;
  unitPrice: number;
  quantity: number;
}

export interface E2eProposal {
  id: string;
  tenantId: string;
  conversationId: string;
  createdBy: string;
  status: ProposalStatus;
  discountPercent: number;
  /** Igual a `calculateTotal(items, discountPercent)` — verificado em teste. */
  expectedTotal: number;
  approvalStatus: 'none' | 'pending' | 'approved' | 'rejected';
  reasonLost: LossReason | null;
  items: readonly E2eProposalItem[];
}

export const E2E_PROPOSALS = {
  /**
   * Cenario "Aprovação" de TESTING.md: atendente (alcada 15%) criou com 25%.
   * 98 + 48 + 38 = 184,00 - 25% = 138,00.
   */
  pendenteAprovacao: {
    id: 'a0000000-0000-4000-8000-000000000401',
    tenantId: E2E_TENANTS.alfa.id,
    conversationId: E2E_CONVERSATIONS.aprovacao.id,
    createdBy: E2E_USERS.alfaAttendant.id,
    status: 'novo_contato',
    discountPercent: 25,
    expectedTotal: 138.0,
    approvalStatus: 'pending',
    reasonLost: null,
    items: [
      {
        examId: E2E_EXAMS.vitaminaD.id,
        examName: E2E_EXAMS.vitaminaD.name,
        unitPrice: 98.0,
        quantity: 1,
      },
      { examId: E2E_EXAMS.tsh.id, examName: E2E_EXAMS.tsh.name, unitPrice: 48.0, quantity: 1 },
      {
        examId: E2E_EXAMS.hemograma.id,
        examName: E2E_EXAMS.hemograma.name,
        unitPrice: 38.0,
        quantity: 1,
      },
    ],
  },
  /**
   * Cenario "Pipeline": mover de negociacao para perdido exige motivo.
   * 24 + 26 = 50,00 - 10% = 45,00.
   */
  emNegociacao: {
    id: 'a0000000-0000-4000-8000-000000000402',
    tenantId: E2E_TENANTS.alfa.id,
    conversationId: E2E_CONVERSATIONS.pipeline.id,
    createdBy: E2E_USERS.alfaAttendant.id,
    status: 'negociacao',
    discountPercent: 10,
    expectedTotal: 45.0,
    approvalStatus: 'approved',
    reasonLost: null,
    items: [
      {
        examId: E2E_EXAMS.colesterol.id,
        examName: E2E_EXAMS.colesterol.name,
        unitPrice: 24.0,
        quantity: 1,
      },
      {
        examId: E2E_EXAMS.triglicerides.id,
        examName: E2E_EXAMS.triglicerides.name,
        unitPrice: 26.0,
        quantity: 1,
      },
    ],
  },
  /** Proposta ganha: 72,00 sem desconto. Preenche a coluna "Ganho" do pipeline. */
  ganha: {
    id: 'a0000000-0000-4000-8000-000000000403',
    tenantId: E2E_TENANTS.alfa.id,
    conversationId: E2E_CONVERSATIONS.atribuida.id,
    createdBy: E2E_USERS.alfaAttendant.id,
    status: 'ganho',
    discountPercent: 0,
    expectedTotal: 72.0,
    approvalStatus: 'none',
    reasonLost: null,
    items: [
      { examId: E2E_EXAMS.psa.id, examName: E2E_EXAMS.psa.name, unitPrice: 72.0, quantity: 1 },
    ],
  },
  /** Proposta perdida com motivo — a coluna "Perdido" nao fica vazia. */
  perdida: {
    id: 'a0000000-0000-4000-8000-000000000404',
    tenantId: E2E_TENANTS.alfa.id,
    conversationId: E2E_CONVERSATIONS.naoAtribuida.id,
    createdBy: E2E_USERS.alfaAttendant.id,
    status: 'perdido',
    discountPercent: 0,
    expectedTotal: 60.0,
    approvalStatus: 'none',
    reasonLost: 'preco',
    items: [
      {
        examId: E2E_EXAMS.hemograma.id,
        examName: E2E_EXAMS.hemograma.name,
        unitPrice: 38.0,
        quantity: 1,
      },
      {
        examId: E2E_EXAMS.glicose.id,
        examName: E2E_EXAMS.glicose.name,
        unitPrice: 22.0,
        quantity: 1,
      },
    ],
  },
  /** Cenario "Isolamento": um usuario do Alfa nunca pode ver esta proposta. */
  betaSecreta: {
    id: 'b0000000-0000-4000-8000-000000000401',
    tenantId: E2E_TENANTS.beta.id,
    conversationId: E2E_CONVERSATIONS.betaSecreta.id,
    createdBy: E2E_USERS.betaAttendant.id,
    status: 'orcamento_enviado',
    discountPercent: 0,
    expectedTotal: 66.0,
    approvalStatus: 'none',
    reasonLost: null,
    items: [
      {
        examId: E2E_EXAMS_BETA.hemograma.id,
        examName: E2E_EXAMS_BETA.hemograma.name,
        unitPrice: 41.0,
        quantity: 1,
      },
      {
        examId: E2E_EXAMS_BETA.glicose.id,
        examName: E2E_EXAMS_BETA.glicose.name,
        unitPrice: 25.0,
        quantity: 1,
      },
    ],
  },
} as const satisfies Record<string, E2eProposal>;

/** Canais internos criados no onboarding (WORKFLOWS.md §7). */
export const E2E_CHANNELS = {
  geral: { key: 'geral', name: '#geral' },
  aprovacoes: { key: 'aprovacoes', name: '#aprovacoes' },
} as const;

/**
 * Texto exato do post de sistema em `#aprovacoes` referente a
 * `E2E_PROPOSALS.pendenteAprovacao` — o spec de aprovacao localiza o cartao
 * por este texto.
 */
export const E2E_APPROVAL_POST =
  '@gestor Pedido de aprovação de desconto: Juliana Prado - R$ 138,00 (25% — acima da alçada de 15%)';

/**
 * Canal conectado por laboratorio (D-064). `apiToken` e `webhookSecret` sao
 * valores de TESTE: existem aqui para o E2E provar que a API devolve
 * `apiTokenMasked` / `webhookSecretSet` e NUNCA o valor em claro.
 */
export interface E2eTenantChannel {
  id: string;
  tenantId: string;
  channel: ConversationChannel;
  displayName: string;
  phoneNumberId: string;
  phoneNumber: string;
  apiToken: string;
  webhookSecret: string;
  isActive: boolean;
  /** O que a API deve devolver no lugar do token: '••••••••' + 4 ultimos. */
  expectedApiTokenMasked: string;
}

export const E2E_TENANT_CHANNELS = {
  alfaWhatsapp: {
    id: 'a0000000-0000-4000-8000-000000000601',
    tenantId: E2E_TENANTS.alfa.id,
    channel: 'whatsapp',
    displayName: 'WhatsApp do Alfa',
    phoneNumberId: '111111111111111',
    phoneNumber: '+55 48 3333-1001',
    apiToken: 'EAAG-alfa-token-abcd',
    webhookSecret: 'alfa-webhook-secret',
    isActive: true,
    expectedApiTokenMasked: '••••••••abcd',
  },
  betaWhatsapp: {
    id: 'b0000000-0000-4000-8000-000000000601',
    tenantId: E2E_TENANTS.beta.id,
    channel: 'whatsapp',
    displayName: 'WhatsApp do Beta',
    phoneNumberId: '222222222222222',
    phoneNumber: '+55 51 3333-2001',
    apiToken: 'EAAG-beta-token-wxyz',
    webhookSecret: 'beta-webhook-secret',
    isActive: true,
    expectedApiTokenMasked: '••••••••wxyz',
  },
} as const satisfies Record<string, E2eTenantChannel>;

/**
 * Configuracao operacional (D-065).
 *
 * O ALFA tem linha (round_robin, saudacao ligada); o BETA **nao tem linha
 * nenhuma** de proposito — linha ausente = defaults, e esse e o caminho normal
 * em producao. Semear os dois esconderia justamente o caso que o `GET` precisa
 * responder sem gravar.
 */
export interface E2eTenantSettings {
  tenantId: string;
  distributionMode: DistributionMode;
  greeting: { enabled: boolean; message: string | null };
  offHours: { enabled: boolean; message: string | null };
  businessHours: BusinessHours;
}

export const E2E_TENANT_SETTINGS = {
  alfa: {
    tenantId: E2E_TENANTS.alfa.id,
    distributionMode: 'round_robin',
    greeting: {
      enabled: true,
      message: 'Olá! Recebemos sua mensagem e já vamos te atender.',
    },
    offHours: {
      enabled: true,
      message: 'Estamos fora do horário de atendimento. Respondemos amanhã a partir das 8h.',
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
  },
} as const satisfies Record<string, E2eTenantSettings>;

/**
 * Tenant SEM linha em `tenant_settings` — o `GET` responde os defaults de D-065
 * sem gravar nada. Constante nomeada para que o spec diga o que testa.
 */
export const E2E_TENANT_WITHOUT_SETTINGS = E2E_TENANTS.beta.id;

/**
 * Estado de leitura do chat interno (D-068).
 *
 * O canal e identificado pela CHAVE (`geral` / `aprovacoes`), nao por id: os ids
 * dos canais e2e sao derivados por hash no seed, e repeti-los aqui criaria uma
 * segunda fonte para o mesmo valor.
 */
export interface E2eChannelRead {
  tenantId: string;
  channelKey: 'geral' | 'aprovacoes';
  userId: string;
  /** Quantas horas antes de `now` o usuario abriu o canal pela ultima vez. */
  readHoursAgo: number;
}

export const E2E_CHANNEL_READS = [
  /** Gestor ja leu #geral depois do unico post => badge zerado. */
  {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'geral',
    userId: E2E_USERS.alfaManager.id,
    readHoursAgo: 1,
  },
  /**
   * Admin abriu #aprovacoes ANTES do pedido de aprovacao (que e de 3h atras):
   * a linha existe e mesmo assim o badge conta 1. Prova que o `unreadCount`
   * compara com `last_read_at`, e nao apenas "tem linha / nao tem".
   */
  {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'aprovacoes',
    userId: E2E_USERS.alfaAdmin.id,
    readHoursAgo: 24,
  },
] as const satisfies readonly E2eChannelRead[];

/**
 * `unreadCount` esperado por (usuario, canal) logo apos o seed — DERIVADO das
 * mensagens e de `E2E_CHANNEL_READS`, nunca materializado (BUSINESS_RULES §5).
 *
 * O cenario do badge do chat interno e o do GESTOR em #aprovacoes: ele nao tem
 * linha de leitura, entao abre com 1 nao lida (o post de sistema conta — D-068)
 * e `POST /internal-chat/channels/:id/read` tem que zerar.
 */
export const E2E_CHANNEL_UNREAD = {
  managerAprovacoes: {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'aprovacoes',
    userId: E2E_USERS.alfaManager.id,
    expected: 1,
  },
  managerGeral: {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'geral',
    userId: E2E_USERS.alfaManager.id,
    expected: 0,
  },
  adminAprovacoes: {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'aprovacoes',
    userId: E2E_USERS.alfaAdmin.id,
    expected: 1,
  },
  /** O unico post de #geral e do proprio admin — mensagem propria nunca conta. */
  adminGeral: {
    tenantId: E2E_TENANTS.alfa.id,
    channelKey: 'geral',
    userId: E2E_USERS.alfaAdmin.id,
    expected: 0,
  },
} as const;
