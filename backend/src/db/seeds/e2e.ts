/**
 * Dataset E2E (`npm run seed:e2e`) — DETERMINISTICO.
 *
 * Nada aqui e sorteado: os IDs, e-mails, senhas, precos e totais vem de
 * `e2e-fixtures.ts`, que o Playwright importa. Rodar duas vezes produz
 * exatamente as mesmas linhas com os mesmos IDs.
 *
 * Cobre os 7 cenarios de `docs/guides/TESTING.md`:
 *   login · atendimento · orcamento · aprovacao 25% · pipeline ·
 *   personalizacao · isolamento
 */
import { hashPassword } from '../../lib/password.js';
import type { DbTx } from '../types.js';
import { EXAM_CATALOG } from './catalog.js';
import {
  E2E_APPROVAL_POST,
  E2E_CHANNELS,
  E2E_CONVERSATIONS,
  E2E_EXAMS,
  E2E_EXAMS_BETA,
  E2E_PASSWORD,
  E2E_PROPOSALS,
  E2E_TENANTS,
  E2E_USERS,
  type E2eConversation,
  type E2eExam,
  type E2eProposal,
  type E2eUser,
} from './e2e-fixtures.js';
import { seedUuid } from './ids.js';
import {
  DEFAULT_FONT_ID,
  DEFAULT_RADIUS_ID,
  THEME_AZUL_JALECO,
  THEME_TERRACOTA,
} from './themes.js';
import {
  insertAuditLog,
  insertChannel,
  insertConversation,
  insertExam,
  insertInternalMessage,
  insertMessage,
  insertProposal,
  insertTenant,
  insertTheme,
  insertUser,
  type SeedStatusStep,
} from './writers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** Caminho de estagios ate o status final de cada proposta fixa. */
const E2E_PATHS: Record<string, readonly SeedStatusStep['status'][]> = {
  [E2E_PROPOSALS.pendenteAprovacao.id]: ['novo_contato'],
  [E2E_PROPOSALS.emNegociacao.id]: ['novo_contato', 'orcamento_enviado', 'negociacao'],
  [E2E_PROPOSALS.ganha.id]: ['novo_contato', 'orcamento_enviado', 'ganho'],
  [E2E_PROPOSALS.perdida.id]: ['novo_contato', 'orcamento_enviado', 'perdido'],
  [E2E_PROPOSALS.betaSecreta.id]: ['novo_contato', 'orcamento_enviado'],
};

export async function seedE2e(tx: DbTx, now: Date): Promise<{ users: number; proposals: number }> {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  const createdAt = new Date(now.getTime() - 30 * DAY_MS);

  // ---- tenants + temas ------------------------------------------------------
  await insertTenant(tx, {
    id: E2E_TENANTS.alfa.id,
    name: E2E_TENANTS.alfa.name,
    slug: E2E_TENANTS.alfa.slug,
    plan: 'pro',
    subscriptionUntil: new Date(now.getTime() + 365 * DAY_MS),
    createdAt,
  });
  await insertTheme(tx, {
    id: seedUuid('e2e', 'theme', E2E_TENANTS.alfa.slug),
    tenantId: E2E_TENANTS.alfa.id,
    preset: THEME_TERRACOTA,
    brandName: E2E_TENANTS.alfa.name,
    fontId: DEFAULT_FONT_ID,
    radiusId: DEFAULT_RADIUS_ID,
    createdAt,
  });

  await insertTenant(tx, {
    id: E2E_TENANTS.beta.id,
    name: E2E_TENANTS.beta.name,
    slug: E2E_TENANTS.beta.slug,
    plan: 'starter',
    subscriptionUntil: new Date(now.getTime() + 365 * DAY_MS),
    createdAt,
  });
  await insertTheme(tx, {
    id: seedUuid('e2e', 'theme', E2E_TENANTS.beta.slug),
    tenantId: E2E_TENANTS.beta.id,
    preset: THEME_AZUL_JALECO,
    brandName: E2E_TENANTS.beta.name,
    fontId: DEFAULT_FONT_ID,
    radiusId: DEFAULT_RADIUS_ID,
    createdAt,
  });

  // ---- usuarios -------------------------------------------------------------
  const users: readonly E2eUser[] = Object.values(E2E_USERS);
  for (const user of users) {
    await insertUser(tx, {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      discountLimit: user.discountLimit,
      passwordHash,
      lastLoginAt: null,
      createdAt,
    });
  }

  // ---- canais internos (onboarding, WORKFLOWS §7) ---------------------------
  const channelIds = new Map<string, string>();
  for (const tenant of [E2E_TENANTS.alfa, E2E_TENANTS.beta]) {
    for (const channel of Object.values(E2E_CHANNELS)) {
      const id = seedUuid('e2e', 'channel', tenant.slug, channel.key);
      await insertChannel(tx, {
        id,
        tenantId: tenant.id,
        key: channel.key,
        name: channel.name,
        kind: 'channel',
        createdAt,
      });
      channelIds.set(`${tenant.id}:${channel.key}`, id);
    }
  }

  // ---- catalogo -------------------------------------------------------------
  const byCode = new Map(EXAM_CATALOG.map((exam) => [exam.code, exam]));
  const allExams: readonly E2eExam[] = [
    ...Object.values(E2E_EXAMS),
    ...Object.values(E2E_EXAMS_BETA),
  ];
  for (const fixture of allExams) {
    const base = byCode.get(fixture.code);
    if (!base) throw new Error(`Fixture e2e referencia código inexistente: ${fixture.code}`);
    await insertExam(tx, {
      id: fixture.id,
      tenantId: fixture.tenantId,
      exam: {
        ...base,
        name: fixture.name,
        pricePrivate: fixture.pricePrivate,
        priceInsurance: fixture.priceInsurance,
      },
      createdAt,
    });
  }

  // ---- conversas + mensagens ------------------------------------------------
  const conversations: readonly E2eConversation[] = Object.values(E2E_CONVERSATIONS);
  for (const conversation of conversations) {
    const convCreatedAt = new Date(now.getTime() - 5 * DAY_MS);
    await insertConversation(tx, {
      id: conversation.id,
      tenantId: conversation.tenantId,
      patientName: conversation.patientName,
      patientPhone: conversation.patientPhone,
      patientEmail: null,
      assignedTo: conversation.assignedTo,
      channel: 'whatsapp',
      status: 'active',
      unreadCount: conversation.unreadCount,
      tags: ['particular'],
      lastMessageAt: new Date(convCreatedAt.getTime() + 30 * MIN_MS),
      createdAt: convCreatedAt,
    });

    // Os 3 tipos de bolha aparecem em toda conversa e2e.
    const script: Array<{ senderType: 'patient' | 'agent' | 'system'; content: string }> = [
      {
        senderType: 'patient',
        content: 'Olá! Gostaria de um orçamento para os exames do meu pedido médico.',
      },
      {
        senderType: 'system',
        content: conversation.assignedTo
          ? 'Conversa atribuída ao atendente.'
          : 'Conversa aguardando atribuição.',
      },
    ];
    if (conversation.assignedTo) {
      script.push({
        senderType: 'agent',
        content: 'Claro! Já vou montar o orçamento com os exames solicitados.',
      });
    }

    for (const [index, message] of script.entries()) {
      await insertMessage(tx, {
        id: seedUuid('e2e', 'message', conversation.id, index),
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        senderType: message.senderType,
        senderId: message.senderType === 'agent' ? conversation.assignedTo : null,
        content: message.content,
        messageType: 'text',
        status: 'delivered',
        readAt: null,
        createdAt: new Date(convCreatedAt.getTime() + index * 10 * MIN_MS),
      });
    }
  }

  // ---- propostas ------------------------------------------------------------
  const proposals: readonly E2eProposal[] = Object.values(E2E_PROPOSALS);
  for (const proposal of proposals) {
    const statuses = E2E_PATHS[proposal.id];
    if (!statuses) throw new Error(`Proposta e2e ${proposal.id} sem caminho de estágios definido.`);

    const start = now.getTime() - 4 * DAY_MS;
    const path: SeedStatusStep[] = statuses.map((status, index) => ({
      status,
      changedBy: proposal.createdBy,
      changedAt: new Date(start + index * DAY_MS),
    }));

    const approvedBy =
      proposal.approvalStatus === 'approved'
        ? proposal.tenantId === E2E_TENANTS.alfa.id
          ? E2E_USERS.alfaManager.id
          : E2E_USERS.betaAttendant.id
        : null;

    const result = await insertProposal(tx, {
      id: proposal.id,
      tenantId: proposal.tenantId,
      conversationId: proposal.conversationId,
      createdBy: proposal.createdBy,
      items: proposal.items.map((item) => ({ ...item })),
      discountPercent: proposal.discountPercent,
      path,
      approvalStatus: proposal.approvalStatus,
      approvedBy,
      approvedAt: approvedBy ? new Date(start + 30 * MIN_MS) : null,
      reasonLost: proposal.reasonLost,
      sentAt: path.length > 1 ? (path[1] as SeedStatusStep).changedAt : null,
      createdAt: (path[0] as SeedStatusStep).changedAt,
    });

    if (result.totalPrice !== proposal.expectedTotal) {
      throw new Error(
        `Fixture e2e ${proposal.id}: expectedTotal ${proposal.expectedTotal} não bate com ` +
          `calculateTotal() = ${result.totalPrice}. Corrija a constante em e2e-fixtures.ts.`,
      );
    }

    await insertAuditLog(tx, {
      id: seedUuid('e2e', 'audit', proposal.id, 'create'),
      tenantId: proposal.tenantId,
      userId: proposal.createdBy,
      action: 'create_proposal',
      entityType: 'proposal',
      entityId: proposal.id,
      oldValues: null,
      newValues: {
        status: 'novo_contato',
        discountPercent: proposal.discountPercent,
        totalPrice: result.totalPrice,
      },
      timestamp: (path[0] as SeedStatusStep).changedAt,
    });
  }

  // ---- pedido de aprovacao em #aprovacoes (cenario "Aprovação") -------------
  const aprovacoesAlfa = channelIds.get(`${E2E_TENANTS.alfa.id}:aprovacoes`) as string;
  await insertInternalMessage(tx, {
    id: seedUuid('e2e', 'internal-msg', 'aprovacoes', 0),
    tenantId: E2E_TENANTS.alfa.id,
    channelId: aprovacoesAlfa,
    senderId: null,
    content: E2E_APPROVAL_POST,
    attachedProposalId: E2E_PROPOSALS.pendenteAprovacao.id,
    isSystem: true,
    createdAt: new Date(now.getTime() - 3 * 60 * MIN_MS),
  });

  const geralAlfa = channelIds.get(`${E2E_TENANTS.alfa.id}:geral`) as string;
  await insertInternalMessage(tx, {
    id: seedUuid('e2e', 'internal-msg', 'geral', 0),
    tenantId: E2E_TENANTS.alfa.id,
    channelId: geralAlfa,
    senderId: E2E_USERS.alfaAdmin.id,
    content: 'Bem-vindos ao canal geral do laboratório.',
    attachedProposalId: null,
    isSystem: false,
    createdAt: new Date(now.getTime() - 4 * 60 * MIN_MS),
  });

  return { users: users.length, proposals: proposals.length };
}
