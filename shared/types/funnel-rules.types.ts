/**
 * Regras do funil — página Configurações → Regras (CRMLAB-56, D-190..D-194).
 * Espelha docs/api/API_CONTRACTS.md §6c.
 *
 * Uma configuração por laboratório (`funnel_rules`, SCHEMA.md §32). Sem linha
 * gravada valem os `DEFAULT_FUNNEL_RULES`, que reproduzem EXATAMENTE o
 * comportamento anterior ao card (D-191): a matriz de `ALLOWED_TRANSITIONS`,
 * `ganho`/`perdido` terminais, motivo obrigatório no `perdido`.
 *
 * As travas de movimentação manual (`manualMoves`) são lidas por front e back
 * pela MESMA função (`checkTransition`), no espírito de `ALLOWED_TRANSITIONS`:
 * divergir é impossível por construção. A automação (`automation`) só é
 * GUARDADA aqui — quem executa são o motor de tempo (CRMLAB-59) e a régua de
 * fatos (CRMLAB-60).
 */
import type { UserRole } from './auth.types.js';
import { ALLOWED_TRANSITIONS, TERMINAL_STATUSES, type ProposalStatus } from './proposal.types.js';

/** Perfis que a regra pode liberar. `admin` sempre pode (D-192). */
export type RuleActorRole = 'attendant' | 'manager';

export const RULE_ACTOR_ROLES: readonly RuleActorRole[] = ['attendant', 'manager'] as const;

/** Como os prazos em dias são contados. */
export type DayCounting = 'calendar' | 'business';

export const DAY_COUNTINGS: readonly DayCounting[] = ['calendar', 'business'] as const;

/** Seção 1 — de onde a proposta nasce. Ao menos uma fica ligada. */
export interface ProposalOriginRules {
  /** A proposta nasce do orçamento do Bitlab (CRMLAB-57). */
  fromBitlab: boolean;
  /**
   * A atendente cria a proposta no CRM, com itens do catálogo (fluxo anterior).
   * Desligado: o botão some e `POST /proposals` devolve `MANUAL_PROPOSAL_DISABLED`.
   */
  manualInCrm: boolean;
}

export interface ToggleRule {
  enabled: boolean;
}

export interface DelayRule {
  enabled: boolean;
  /** Inteiro 1..365. */
  days: number;
}

export interface HoursRule {
  enabled: boolean;
  /** Inteiro 1..720. */
  hours: number;
}

/** Seção 2 — automação do funil. Só guardada neste card (quem executa: CRMLAB-59/60). */
export interface FunnelAutomationRules {
  /** Requisição no LIS → `negociacao`. */
  requisitionToNegotiation: ToggleRule;
  /** Pagamento no LIS → `ganho`. */
  paymentToWon: ToggleRule;
  /** `orcamento_enviado` há X dias → `follow_up`. */
  sentToFollowUp: DelayRule;
  /** `negociacao` sem pagamento há Y dias → `follow_up`. */
  negotiationToFollowUp: DelayRule;
  /** `follow_up` há Z dias → `perdido` com motivo `silencio`. */
  followUpToLost: DelayRule;
  /** Alerta de "Novo orçamento" parado há N horas sem envio. */
  staleNewBudgetAlert: HoursRule;
  /** Contagem dos prazos em dias: corridos ou úteis. */
  dayCounting: DayCounting;
}

export interface ReopenRule {
  enabled: boolean;
  /** Quem reabre, além do admin. */
  roles: RuleActorRole[];
}

/** Seção 3 — travas da movimentação manual. Valem no back E no front. */
export interface ManualMoveRules {
  /** Reabrir `ganho`/`perdido` (volta para `REOPEN_TARGETS`). */
  reopenClosed: ReopenRule;
  /** `true` = matriz `ALLOWED_TRANSITIONS`; `false` = `SEQUENTIAL_TRANSITIONS`. */
  skipStages: boolean;
  /** `perdido` exige `reasonLost`. */
  requireLossReason: boolean;
  /** Gestor move card de outra atendente. Admin sempre pode; atendente só vê as próprias (D-042). */
  moveOthersCards: boolean;
}

/** Seção 4 — mensagem de envio do orçamento pelo WhatsApp (CRMLAB-58 usa). */
export interface SendMessageRules {
  /** 1..1000 caracteres, só com as variáveis de `SEND_MESSAGE_VARIABLES`. */
  template: string;
}

/** Um disparo de reingajamento (CRMLAB-62, D-211). */
export interface ReengagementStepRule {
  enabled: boolean;
  /**
   * Inteiro 1..720. No 1º: horas desde a última mensagem da atendente.
   * No 2º: horas desde o envio do 1º.
   */
  hours: number;
  /** 1..1000 caracteres, texto fixo (sem variáveis). */
  message: string;
}

/**
 * Seção 5 — reingajamento da conversa (CRMLAB-62, D-211..D-214). Só WhatsApp
 * por QR Code; respeita horário de funcionamento e feriados. O 2º só liga com
 * o 1º ligado.
 */
export interface ReengagementRules {
  first: ReengagementStepRule;
  second: ReengagementStepRule;
}

/**
 * Seção 5b — alerta de tempo de resposta (CRMLAB-84, D-254). O inverso do
 * reingajamento: destaca na lista de conversas o paciente que espera a
 * atendente há `minutes` minutos ÚTEIS (expediente e feriados, como o
 * reingajamento). Só visual — não envia nada. Quem calcula é a lista, no
 * navegador (`responseAlertMinutes`, `response-alert.types.ts`).
 */
export interface ResponseAlertRules {
  enabled: boolean;
  /** Inteiro 1..1440 (`RESPONSE_ALERT_MINUTES_MIN`/`_MAX`). */
  minutes: number;
}

/**
 * Seção 6 — de onde vêm os orçamentos do LIS (CRMLAB-53, D-189 item 4). A carga
 * principal é a API do Bitlab; a planilha é plano B. Desligada: o botão
 * "Importar planilha" some e `POST /lis-imports` devolve
 * `SPREADSHEET_IMPORT_DISABLED`.
 */
export interface LisSourceRules {
  spreadsheetImport: ToggleRule;
}

/** `GET /settings/funnel-rules` — objeto completo, já com os padrões aplicados. */
export interface FunnelRules {
  origin: ProposalOriginRules;
  automation: FunnelAutomationRules;
  manualMoves: ManualMoveRules;
  sendMessage: SendMessageRules;
  reengagement: ReengagementRules;
  responseAlert: ResponseAlertRules;
  lisSource: LisSourceRules;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/**
 * `PATCH /settings/funnel-rules` — parcial em qualquer nível; campo ausente
 * preserva. Listas (`roles`) são trocadas inteiras.
 */
export type UpdateFunnelRulesRequest = DeepPartial<FunnelRules>;

export const SEND_MESSAGE_VARIABLES = [
  'paciente',
  'numero_orcamento',
  'valor',
  'convenio',
] as const;

export type SendMessageVariable = (typeof SEND_MESSAGE_VARIABLES)[number];

export const SEND_MESSAGE_TEMPLATE_MAX = 1000;

export const DEFAULT_SEND_MESSAGE_TEMPLATE =
  'Olá, {paciente}! Segue o orçamento nº {numero_orcamento} ({convenio}), no valor de {valor}.';

export const REENGAGEMENT_MESSAGE_MAX = 1000;

export const DEFAULT_REENGAGEMENT_FIRST_MESSAGE =
  'Olá! Passando para saber se ficou alguma dúvida sobre o que conversamos. Seguimos à disposição para ajudar.';

export const DEFAULT_REENGAGEMENT_SECOND_MESSAGE =
  'Olá! Como não tivemos retorno, vamos deixar o atendimento em aberto. Quando quiser, é só responder esta mensagem.';

/** Padrões (D-191). Ver o comentário do topo do arquivo. */
export const DEFAULT_FUNNEL_RULES: FunnelRules = {
  origin: { fromBitlab: true, manualInCrm: true },
  automation: {
    requisitionToNegotiation: { enabled: true },
    paymentToWon: { enabled: true },
    sentToFollowUp: { enabled: true, days: 3 },
    negotiationToFollowUp: { enabled: true, days: 7 },
    followUpToLost: { enabled: false, days: 15 },
    staleNewBudgetAlert: { enabled: true, hours: 4 },
    dayCounting: 'calendar',
  },
  manualMoves: {
    reopenClosed: { enabled: false, roles: ['manager'] },
    skipStages: true,
    requireLossReason: true,
    moveOthersCards: true,
  },
  sendMessage: { template: DEFAULT_SEND_MESSAGE_TEMPLATE },
  // Desligado: laboratório que já usa não passa a mandar nada sozinho (D-211).
  reengagement: {
    first: { enabled: false, hours: 1, message: DEFAULT_REENGAGEMENT_FIRST_MESSAGE },
    second: { enabled: false, hours: 24, message: DEFAULT_REENGAGEMENT_SECOND_MESSAGE },
  },
  // Desligado: o destaque vermelho só aparece quando o laboratório liga (D-254).
  responseAlert: { enabled: false, minutes: 15 },
  // Emenda à D-191 (D-189 item 5): a planilha nasce DESLIGADA — a API é a carga principal.
  lisSource: { spreadsheetImport: { enabled: false } },
};

// ---------------------------------------------------------------------------
// Travas de movimentação manual
// ---------------------------------------------------------------------------

/**
 * Matriz sem pular etapas (`skipStages: false`): um passo para a frente, um
 * para trás (D-105) e `perdido` de qualquer estágio aberto.
 */
export const SEQUENTIAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  novo_contato: ['orcamento_enviado', 'perdido'],
  orcamento_enviado: ['novo_contato', 'follow_up', 'perdido'],
  follow_up: ['orcamento_enviado', 'negociacao', 'perdido'],
  negociacao: ['follow_up', 'ganho', 'perdido'],
  ganho: [],
  perdido: [],
} as const;

/** Para onde uma proposta fechada volta quando a regra deixa reabrir. */
export const REOPEN_TARGETS: readonly ProposalStatus[] = [
  'orcamento_enviado',
  'follow_up',
  'negociacao',
] as const;

/** Quem tenta mover o card. */
export interface TransitionActor {
  role: UserRole;
  /**
   * `true` quando o card é de quem move (`createdBy === userId`) ou quando o
   * card ainda não tem responsável (cartão do Bitlab na fila comum, D-195) —
   * use `isCardOwner` para calcular.
   */
  isOwner: boolean;
}

/**
 * Dono para efeito da trava "mover card de outra atendente". Cartão sem
 * responsável (origem `bitlab` antes do envio, D-195) é da fila comum:
 * qualquer atendente que o vê pode movê-lo.
 */
export function isCardOwner(createdBy: string | null, userId: string | null | undefined): boolean {
  return createdBy === null || createdBy === userId;
}

/**
 * Por que a transição foi recusada:
 * - `closed`: proposta fechada e a regra não deixa reabrir;
 * - `reopen_role`: reabrir está ligado, mas não para este perfil;
 * - `not_allowed`: destino fora da matriz vigente;
 * - `not_owner`: card de outra pessoa e a regra não deixa mover.
 */
export type TransitionDenial = 'closed' | 'reopen_role' | 'not_allowed' | 'not_owner';

function isClosed(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Matriz vigente para as regras: a de estágios abertos + a reabertura, se ligada. */
export function buildAllowedTransitions(
  rules: ManualMoveRules,
): Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> {
  const base = rules.skipStages ? ALLOWED_TRANSITIONS : SEQUENTIAL_TRANSITIONS;
  const reopen = rules.reopenClosed.enabled ? REOPEN_TARGETS : [];
  return { ...base, ganho: reopen, perdido: reopen };
}

export function canReopen(rules: ManualMoveRules, role: UserRole): boolean {
  if (!rules.reopenClosed.enabled) return false;
  if (role === 'admin') return true;
  return (rules.reopenClosed.roles as readonly string[]).includes(role);
}

/**
 * A trava "Mover card de outra atendente" sozinha: dona (ou cartao sem
 * responsavel), admin sempre, gestor se `moveOthersCards`. E o que
 * `checkTransition` usa, e o que o envio pelo cartao (CRMLAB-58, D-200 item 2)
 * confere — o destino do envio e de sistema, mas quem envia continua sendo uma
 * pessoa.
 */
export function canActOnCard(rules: ManualMoveRules, actor: TransitionActor): boolean {
  if (actor.isOwner || actor.role === 'admin') return true;
  return actor.role === 'manager' && rules.moveOthersCards;
}

const canMoveCard = canActOnCard;

/**
 * A decisão de uma transição manual. `null` = permitida. O backend traduz a
 * recusa em erro (`ProposalService.updateStatus`); o front esconde o que daria
 * recusa. A conciliação LIS (`markWonFromLis`, D-119) NÃO passa por aqui.
 */
export function checkTransition(
  rules: ManualMoveRules,
  from: ProposalStatus,
  to: ProposalStatus,
  actor: TransitionActor,
): TransitionDenial | null {
  if (isClosed(from)) {
    if (!rules.reopenClosed.enabled) return 'closed';
    if (!canReopen(rules, actor.role)) return 'reopen_role';
  }
  if (!buildAllowedTransitions(rules)[from].includes(to)) return 'not_allowed';
  if (!canMoveCard(rules, actor)) return 'not_owner';
  return null;
}

export function canTransition(
  rules: ManualMoveRules,
  from: ProposalStatus,
  to: ProposalStatus,
  actor: TransitionActor,
): boolean {
  return checkTransition(rules, from, to, actor) === null;
}

/** Destinos que este ator pode escolher a partir de `from` (o que a tela oferece). */
export function allowedTargets(
  rules: ManualMoveRules,
  from: ProposalStatus,
  actor: TransitionActor,
): ProposalStatus[] {
  return buildAllowedTransitions(rules)[from].filter((to) => canTransition(rules, from, to, actor));
}

// ---------------------------------------------------------------------------
// Mensagem de envio
// ---------------------------------------------------------------------------

const TEMPLATE_VARIABLE = /\{([^{}]*)\}/g;

/** Variáveis `{x}` do modelo que não existem em `SEND_MESSAGE_VARIABLES`, sem repetição. */
export function findUnknownTemplateVariables(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_VARIABLE)) {
    const name = match[1] ?? '';
    if (!(SEND_MESSAGE_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

/**
 * Troca cada `{variavel}` pelo valor JÁ FORMATADO (`valor` chega como
 * `"R$ 1.234,50"`, `numero_orcamento` como vier do LIS). Variável
 * desconhecida fica como está — o modelo gravado já foi validado.
 */
export function renderSendMessageTemplate(
  template: string,
  values: Readonly<Record<SendMessageVariable, string>>,
): string {
  return template.replace(TEMPLATE_VARIABLE, (whole, name: string) =>
    (SEND_MESSAGE_VARIABLES as readonly string[]).includes(name)
      ? values[name as SendMessageVariable]
      : whole,
  );
}

// ---------------------------------------------------------------------------
// Envio pelo cartao (CRMLAB-58)
// ---------------------------------------------------------------------------

/**
 * Estagio para onde o cartao `bitlab` vai quando e enviado (D-200 item 5).
 * Com requisicao (pre-cadastro, D-197) e "Requisicao -> Negociacao" ligada:
 * `negociacao` — transicao de sistema, fora da matriz manual. Senao,
 * `orcamento_enviado`.
 */
export function bitlabSendTarget(
  lisRequisitionNumber: string | null,
  automation: Pick<FunnelAutomationRules, 'requisitionToNegotiation'>,
): 'orcamento_enviado' | 'negociacao' {
  return lisRequisitionNumber !== null && automation.requisitionToNegotiation.enabled
    ? 'negociacao'
    : 'orcamento_enviado';
}
