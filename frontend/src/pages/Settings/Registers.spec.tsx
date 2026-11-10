import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthUser, UserRole } from '@crm-lab/shared';
import { PageHeader, PageTabs } from '@/components/layout';
import { useAuthStore } from '@/stores';
import { RegistersLayout, RegistersRedirect } from './Registers';

/** Cadastros (CRMLAB-143): faixa de abas por perfil + redirect para a primeira aba. */

function login(role: UserRole): void {
  const user: AuthUser = { id: 'u-1', email: 'a@lab.com', name: 'Marina', role, discountLimit: 15 };
  useAuthStore.setState({ user, tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 } });
}

/** Tela de mentira: a faixa aparece por dentro dela, pelo `PageHeader` (ou `PageTabs`). */
function Where() {
  const { pathname } = useLocation();
  return (
    <>
      {pathname === '/catalog' ? <PageTabs /> : <PageHeader title="Tela" />}
      <p data-testid="where">{pathname}</p>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/registers" element={<RegistersRedirect />} />
        <Route element={<RegistersLayout />}>
          <Route path="*" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: null, tokens: null });
});

describe('Cadastros — faixa de abas', () => {
  it('admin vê as 5 abas e a da tela atual marcada', () => {
    login('admin');
    renderAt('/catalog');

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Usuários',
      'Exames',
      'Respostas rápidas',
      'Atendentes',
      'Convênios',
    ]);
    expect(screen.getByRole('tab', { name: 'Exames' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Usuários' })).toHaveAttribute('aria-selected', 'false');
  });

  it('atendente só vê Exames e Respostas rápidas', () => {
    login('attendant');
    renderAt('/quick-replies');

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Exames', 'Respostas rápidas']);
  });

  it('clicar na aba navega para o endereço da tela', async () => {
    login('admin');
    renderAt('/catalog');

    await userEvent.click(screen.getByRole('tab', { name: 'Convênios' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/settings/insurances');
    expect(screen.getByRole('tab', { name: 'Convênios' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Cadastros — /settings/registers abre a primeira aba do perfil', () => {
  it.each([
    ['admin', '/settings/users'],
    ['manager', '/catalog'],
    ['attendant', '/catalog'],
  ] as const)('%s → %s', (role, expected) => {
    login(role);
    renderAt('/settings/registers');

    expect(screen.getByTestId('where')).toHaveTextContent(expected);
  });
});

describe('Cadastros — a faixa só existe dentro do layout', () => {
  it('PageHeader fora de Cadastros não desenha abas', () => {
    login('admin');
    render(
      <MemoryRouter>
        <PageHeader title="Outra tela" />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
