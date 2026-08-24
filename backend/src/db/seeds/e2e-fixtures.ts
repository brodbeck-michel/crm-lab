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
import type { LossReason, ProposalStatus, UserRole } from '@crm-lab/shared';

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

export interface E2eConversation {
  id: string;
  tenantId: string;
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
    patientName: 'Carla Pereira',
    patientPhone: '+5548999110001',
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 0,
  },
  /** Cenario "Atendimento": chip "Não atribuídas" precisa de conteudo. */
  naoAtribuida: {
    id: 'a0000000-0000-4000-8000-000000000302',
    tenantId: E2E_TENANTS.alfa.id,
    patientName: 'Marcos Antunes',
    patientPhone: '+5548999110002',
    assignedTo: null,
    unreadCount: 3,
  },
  /** Cenario "Aprovação": conversa da proposta com 25% de desconto. */
  aprovacao: {
    id: 'a0000000-0000-4000-8000-000000000303',
    tenantId: E2E_TENANTS.alfa.id,
    patientName: 'Juliana Prado',
    patientPhone: '+5548999110003',
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 1,
  },
  /** Cenario "Pipeline": conversa da proposta em negociacao. */
  pipeline: {
    id: 'a0000000-0000-4000-8000-000000000304',
    tenantId: E2E_TENANTS.alfa.id,
    patientName: 'Rafael Nunes',
    patientPhone: '+5548999110004',
    assignedTo: E2E_USERS.alfaAttendant.id,
    unreadCount: 0,
  },
  /** Cenario "Isolamento": NADA disto pode aparecer para um usuario do Alfa. */
  betaSecreta: {
    id: 'b0000000-0000-4000-8000-000000000301',
    tenantId: E2E_TENANTS.beta.id,
    patientName: 'Paciente Confidencial Beta',
    patientPhone: '+5551988220001',
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
