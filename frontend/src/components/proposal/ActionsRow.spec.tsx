import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  type ManualMoveRules,
  type ProposalStatus,
  type TransitionActor,
} from '@crm-lab/shared';
import ActionsRow from './ActionsRow';

/**
 * CRMLAB-56 (D-192): o ActionsRow só oferece o que `checkTransition` aceita —
 * a mesma função que o backend usa para recusar.
 */
function rules(patch: Partial<ManualMoveRules> = {}): ManualMoveRules {
  return { ...DEFAULT_FUNNEL_RULES.manualMoves, ...patch };
}

function renderRow(
  status: ProposalStatus,
  opts: { rules?: ManualMoveRules; actor?: TransitionActor; lisReconciled?: boolean; canSend?: boolean } = {},
) {
  const onChangeStatus = vi.fn();
  render(
    <ActionsRow
      status={status}
      onChangeStatus={onChangeStatus}
      onMarkWon={vi.fn()}
      onMarkLost={vi.fn()}
      onSendProposal={vi.fn()}
      isPending={false}
      {...opts}
    />,
  );
  return { onChangeStatus };
}

function stageOptions(label: string): string[] {
  const select = screen.getByLabelText(label);
  return within(select)
    .queryAllByRole('option')
    .filter((option) => !(option as HTMLOptionElement).disabled)
    .map((option) => option.textContent ?? '');
}

const OWNER: TransitionActor = { role: 'attendant', isOwner: true };

describe('ActionsRow — travas das Regras', () => {
  it('padrão: orçamento enviado oferece a matriz de hoje (pula etapas)', () => {
    renderRow('orcamento_enviado');
    expect(stageOptions('Mudar estágio')).toEqual([
      'Novo orçamento',
      'Follow-up',
      'Negociação',
      'Ganho',
      'Perdido',
    ]);
    expect(screen.getByRole('button', { name: 'Marcar como Ganho' })).toBeEnabled();
  });

  it('novo contato não oferece Ganho (o backend recusaria)', () => {
    renderRow('novo_contato');
    expect(screen.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar orçamento' })).toBeInTheDocument();
  });

  it('sem pular etapas: orçamento enviado não vai direto a Ganho nem a Negociação', () => {
    renderRow('orcamento_enviado', { rules: rules({ skipStages: false }), actor: OWNER });
    expect(stageOptions('Mudar estágio')).toEqual(['Novo orçamento', 'Follow-up', 'Perdido']);
    expect(screen.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Avançar para Follow-up' })).toBeInTheDocument();
  });

  it('proposta fechada sem reabrir: sem seletor, Ganho/Perdido desabilitados (como antes)', () => {
    renderRow('ganho');
    expect(screen.queryByLabelText('Reabrir em')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Mudar estágio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Marcar como Perdido' })).toBeDisabled();
  });

  it('reabrir ligado para gestor: gestor escolhe onde retomar', async () => {
    const user = userEvent.setup();
    const { onChangeStatus } = renderRow('perdido', {
      rules: rules({ reopenClosed: { enabled: true, roles: ['manager'] } }),
      actor: { role: 'manager', isOwner: false },
    });
    expect(stageOptions('Reabrir em')).toEqual(['Orçamento enviado', 'Follow-up', 'Negociação']);

    await user.selectOptions(screen.getByLabelText('Reabrir em'), 'follow_up');
    expect(onChangeStatus).toHaveBeenCalledWith('follow_up');
  });

  it('reabrir ligado só para gestor: a atendente não vê a opção', () => {
    renderRow('ganho', {
      rules: rules({ reopenClosed: { enabled: true, roles: ['manager'] } }),
      actor: OWNER,
    });
    expect(screen.queryByLabelText('Reabrir em')).not.toBeInTheDocument();
  });

  it('admin reabre mesmo sem perfil marcado', () => {
    renderRow('ganho', {
      rules: rules({ reopenClosed: { enabled: true, roles: [] } }),
      actor: { role: 'admin', isOwner: false },
    });
    expect(screen.getByLabelText('Reabrir em')).toBeInTheDocument();
  });

  it('ganho conciliado pelo LIS nunca reabre', () => {
    renderRow('ganho', {
      rules: rules({ reopenClosed: { enabled: true, roles: ['manager'] } }),
      actor: { role: 'admin', isOwner: true },
      lisReconciled: true,
    });
    expect(screen.queryByLabelText('Reabrir em')).not.toBeInTheDocument();
  });

  it('gestor sem "mover card de outra atendente": nada oferecido no card alheio', () => {
    renderRow('negociacao', {
      rules: rules({ moveOthersCards: false }),
      actor: { role: 'manager', isOwner: false },
    });
    expect(stageOptions('Mudar estágio')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Marcar como Ganho' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Marcar como Perdido' })).toBeDisabled();
  });

  describe('cartão do Bitlab (CRMLAB-58)', () => {
    it('canSend força o Enviar mesmo com a matriz sem orcamento_enviado; false esconde', () => {
      renderRow('novo_contato', { rules: rules({ skipStages: false }), canSend: true });
      expect(screen.getByRole('button', { name: 'Enviar orçamento' })).toBeInTheDocument();
    });

    it('canSend false esconde o Enviar', () => {
      renderRow('novo_contato', { canSend: false });
      expect(screen.queryByRole('button', { name: 'Enviar orçamento' })).not.toBeInTheDocument();
    });

    it('Reenviar mensagem só nos três estágios abertos depois do envio', () => {
      const onResend = vi.fn();
      const { unmount } = render(
        <ActionsRow
          status="follow_up"
          onChangeStatus={vi.fn()}
          onMarkWon={vi.fn()}
          onMarkLost={vi.fn()}
          onResend={onResend}
          isPending={false}
        />,
      );
      screen.getByRole('button', { name: 'Reenviar mensagem' }).click();
      expect(onResend).toHaveBeenCalled();
      unmount();

      render(
        <ActionsRow
          status="novo_contato"
          onChangeStatus={vi.fn()}
          onMarkWon={vi.fn()}
          onMarkLost={vi.fn()}
          onResend={onResend}
          isPending={false}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Reenviar mensagem' })).not.toBeInTheDocument();
    });
  });
});
