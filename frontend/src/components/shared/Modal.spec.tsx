import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

function setup(onClose = vi.fn()) {
  render(
    <Modal open onClose={onClose} title="Proposta 4776">
      <p>Conteúdo do modal</p>
      <button type="button">Ação interna</button>
    </Modal>,
  );
  return onClose;
}

describe('Modal', () => {
  it('não renderiza nada quando open é false', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Proposta">
        <p>Conteúdo</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renderiza como diálogo modal rotulado pelo título', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Proposta 4776');
  });

  it('fecha por Esc', async () => {
    const onClose = setup();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fecha por clique no backdrop', async () => {
    const onClose = setup();
    await userEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fecha pelo botão ×', async () => {
    const onClose = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('NÃO fecha por clique dentro do cartão', async () => {
    const onClose = setup();
    await userEvent.click(screen.getByText('Conteúdo do modal'));
    await userEvent.click(screen.getByRole('button', { name: 'Ação interna' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('move o foco para o cartão ao abrir', () => {
    setup();
    expect(screen.getByTestId('modal-card')).toHaveFocus();
  });

  it('prende o foco: Tab a partir do último volta ao primeiro', async () => {
    setup();
    const closeButton = screen.getByRole('button', { name: 'Fechar' });
    const innerButton = screen.getByRole('button', { name: 'Ação interna' });

    innerButton.focus();
    await userEvent.tab();
    expect(closeButton).toHaveFocus();
  });

  it('prende o foco: Shift+Tab a partir do primeiro vai ao último', async () => {
    setup();
    const closeButton = screen.getByRole('button', { name: 'Fechar' });
    const innerButton = screen.getByRole('button', { name: 'Ação interna' });

    closeButton.focus();
    await userEvent.tab({ shift: true });
    expect(innerButton).toHaveFocus();
  });

  /**
   * Regressão: o efeito de foco tinha `onClose` nas dependências e chamava
   * `card.focus()` a cada execução. Com um `onClose` recriado a cada render
   * (o caso normal de um formulário controlado dentro do modal), cada tecla
   * digitada roubava o foco do input e só o 1º caractere sobrevivia.
   */
  it('não rouba o foco do input quando onClose é recriado a cada render', async () => {
    function FormInsideModal() {
      const [value, setValue] = useState('');
      // `onClose` recriado a cada render — identidade nova em toda tecla.
      return (
        <Modal open onClose={() => setValue('')} title="Novo Tenant">
          <input
            aria-label="Nome"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Modal>
      );
    }

    render(<FormInsideModal />);
    const input = screen.getByLabelText('Nome');
    input.focus();
    await userEvent.keyboard('Laboratório Vida');

    expect(input).toHaveValue('Laboratório Vida');
    expect(input).toHaveFocus();
  });

  it('cartão usa radius-lg, shadow-lg e largura máxima de 720px', () => {
    setup();
    const card = screen.getByTestId('modal-card');
    expect(card).toHaveClass('rounded-lg');
    expect(card).toHaveClass('shadow-lg');
    expect(card).toHaveClass('max-w-modal');
  });
});
