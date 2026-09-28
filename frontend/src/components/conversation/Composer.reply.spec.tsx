import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

/** Composer — faixa "Respondendo a" (CRMLAB-66, COMPONENTS.md). */
describe('Composer — respondendo a', () => {
  it('mostra autor e trecho; × cancela', async () => {
    const onCancelReply = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        replyTo={{ authorName: 'Maria', preview: 'Posso ir amanhã?' }}
        onCancelReply={onCancelReply}
      />,
    );
    const banner = screen.getByTestId('reply-banner');
    expect(banner).toHaveTextContent('Respondendo a Maria: Posso ir amanhã?');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar resposta' }));
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('Esc no campo também cancela', async () => {
    const onCancelReply = vi.fn();
    render(
      <Composer onSend={vi.fn()} replyTo={{ authorName: 'M', preview: 'x' }} onCancelReply={onCancelReply} />,
    );
    await userEvent.click(screen.getByLabelText('Mensagem'));
    await userEvent.keyboard('{Escape}');
    expect(onCancelReply).toHaveBeenCalledTimes(1);
  });

  it('sem replyTo, nada de faixa', () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByTestId('reply-banner')).toBeNull();
  });
});
