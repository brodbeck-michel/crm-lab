import { useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { UserRole } from '@crm-lab/shared';
import { useToast } from '@/components/ui';
import { useAuthStore, selectIsAuthenticated, selectMustChangePassword, selectRole } from '@/stores';
import { canAccess, homeFor } from './route-config';

/**
 * Guards de rota — docs/frontend/PAGES.md ("Guard de rotas").
 *
 * "A UI esconde, o servidor recusa": estes componentes existem para UX
 * (não mostrar uma tela que o usuário não pode usar). A barreira real é o
 * backend, que valida papel em TODA requisição.
 */

/** Sem sessão → `/login`, guardando de onde veio para voltar depois do login. */
export const CHANGE_PASSWORD_PATH = '/change-password';

export function RequireAuth() {
  const isAuthenticated = useAuthStore(selectIsAuthenticated);
  const mustChangePassword = useAuthStore(selectMustChangePassword);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // Senha provisória (CRMLAB-186, D-326): nada além da troca. A trava de verdade
  // é o 403 PASSWORD_CHANGE_REQUIRED do servidor; isto é só o caminho na tela.
  if (mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }
  return <Outlet />;
}

export interface RequireRolesProps {
  requiredRoles: readonly UserRole[];
}

/** Papel errado → toast + redirect para a home do perfil. */
export function RequireRoles({ requiredRoles }: RequireRolesProps) {
  const role = useAuthStore(selectRole);
  const { toast } = useToast();
  const warned = useRef(false);
  const allowed = canAccess(role, requiredRoles);

  useEffect(() => {
    if (!allowed && role !== null && !warned.current) {
      warned.current = true;
      toast('Você não tem permissão para acessar esta área.', { tone: 'attention' });
    }
  }, [allowed, role, toast]);

  if (role === null) {
    return <Navigate to="/login" replace />;
  }
  if (!allowed) {
    return <Navigate to={homeFor(role)} replace />;
  }
  return <Outlet />;
}

/** `/` → tela inicial do perfil (atendente → `/attendance`). */
export function RoleHomeRedirect() {
  const role = useAuthStore(selectRole);
  return <Navigate to={homeFor(role)} replace />;
}
