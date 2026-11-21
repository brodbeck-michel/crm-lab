import { useQuery } from '@tanstack/react-query';
import { isVisitationResponsibleRole, seesAllVisitation } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import { queryKeys } from '@/api/query-keys';
import { useCurrentUser } from '@/hooks';

export interface VisitationPerson {
  id: string;
  name: string;
}

export interface VisitationResponsibles {
  /** Gestor/admin: veem tudo, filtram por responsável e escolhem quem quiserem. */
  seesAll: boolean;
  /**
   * Quem pode ser responsável por médico/visita (D-329): representantes, gestores
   * e admins ativos. Para o representante, só ele mesmo.
   */
  responsibles: VisitationPerson[];
}

/**
 * Regras de tela da Visitação por perfil (PAGES.md "Perfis na Visitação",
 * CRMLAB-189/D-329). UX apenas: o servidor recorta e recusa de novo.
 */
export function useVisitationResponsibles(): VisitationResponsibles {
  const user = useCurrentUser();
  const seesAll = seesAllVisitation(user?.role);

  // `GET /users` é admin-only; a lista de ativos com papel vem dos responsáveis de conversa.
  const assigneesQuery = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => conversationsApi.assignees(),
    enabled: seesAll,
  });

  if (!seesAll) {
    return { seesAll, responsibles: user ? [{ id: user.id, name: user.name }] : [] };
  }
  const responsibles = (assigneesQuery.data?.assignees ?? [])
    .filter((a) => isVisitationResponsibleRole(a.role))
    .map((a) => ({ id: a.id, name: a.name }));
  return { seesAll, responsibles };
}
