import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState } from '@/components/shared';

/**
 * Placeholders do esqueleto navegável (Agent-UI-Shell).
 *
 * Cada rota do Mapa de Rotas já existe e navega; a TELA de verdade é
 * entregue por outro agente, que substitui o placeholder correspondente
 * em `src/routes/index.tsx` pelo componente real.
 *
 * Nenhum destes componentes busca dado — são casca. O ponto de plugagem é
 * literalmente uma linha no array de rotas.
 */

export interface PlaceholderProps {
  title: string;
  /** O que a tela vai fazer quando existir — ajuda quem for implementar. */
  hint?: string;
}

export function Placeholder({ title, hint }: PlaceholderProps) {
  return (
    <PageContainer>
      <PageHeader title={title} />
      <EmptyState message="Tela em construção" hint={hint} />
    </PageContainer>
  );
}

export const LoginPlaceholder = () => (
  <Placeholder title="Entrar" hint="POST /auth/login → tokens + tema do tenant → redirect por perfil" />
);

export const AttendancePlaceholder = () => (
  <Placeholder title="Atendimento" hint="Inbox de 3 colunas — use InboxLayout de @/components/layout" />
);

export const PatientPlaceholder = () => (
  <Placeholder title="Ficha do Paciente" hint="Cadastro, timeline, propostas e seção LGPD" />
);

export const BudgetPlaceholder = () => (
  <Placeholder title="Novo Orçamento" hint="2 colunas — use BudgetLayout; total sempre derivado" />
);

export const ProposalsPlaceholder = () => (
  <Placeholder title="Pipeline de Propostas" hint="Colunas por estágio; todo cartão abre o Modal da Proposta" />
);

export const CatalogPlaceholder = () => (
  <Placeholder title="Catálogo de Exames" hint="DataTable de @/components/shared; escrita só para gestor+" />
);

export const AnalyticsPlaceholder = () => (
  <Placeholder title="Conversão" hint="Grade auto-fit minmax(224px); atendente vê versão parcial" />
);

export const InternalChatPlaceholder = () => (
  <Placeholder title="Chat Interno" hint="Canais + DMs; #aprovacoes com [Aprovar] [Rejeitar]" />
);

export const ChannelsSettingsPlaceholder = () => (
  <Placeholder title="Canais & Equipe" hint="WhatsApp, distribuição, mensagens automáticas" />
);

export const OperationSettingsPlaceholder = () => (
  <Placeholder title="Gestão da Operação" hint="Fila agora, carga por atendente, decisões pendentes" />
);

export const UsersSettingsPlaceholder = () => (
  <Placeholder title="Usuários & Permissões" hint="Tabela de usuários + aba de auditoria" />
);

export const ThemeSettingsPlaceholder = () => (
  <Placeholder title="Personalização" hint="5 temas prontos + tema livre; prévia ao vivo com applyThemeColors" />
);

export const PlatformTenantsPlaceholder = () => (
  <Placeholder title="Laboratórios Clientes" hint="Lista de tenants, onboarding e saúde" />
);

export const PlatformBillingPlaceholder = () => (
  <Placeholder title="Assinaturas & Uso" hint="Planos, faturas e excedente de mensagens" />
);

export const NotFoundPlaceholder = () => (
  <Placeholder title="Página não encontrada" hint="Confira o endereço ou volte pelo menu lateral" />
);
