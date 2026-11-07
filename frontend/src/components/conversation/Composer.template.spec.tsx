import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WhatsAppTemplate, WhatsAppWindowStatus } from '@crm-lab/shared';
import { Composer } from './Composer';
import { previewTemplate, templateRequestOf } from './TemplatePicker';

/** Composer — envio por modelo aprovado da Meta (CRMLAB-136, D-309). */
const CLOSED: WhatsAppWindowStatus = {
  open: false,
  remainingSeconds: 0,
  expiresAt: null,
  lastPatientMessageAt: null,
};
const OPEN: WhatsAppWindowStatus = {
  open: true,
  remainingSeconds: 3600,
  expiresAt: '2026-11-06T12:00:00.000Z',
  lastPatientMessageAt: '2026-11-05T12:00:00.000Z',
};
const LEMBRETE: WhatsAppTemplate = {
  name: 'lembrete_coleta',
  language: 'pt_BR',
  category: 'utility',
  body: 'Olá {{1}}, sua coleta é {{2}}.',
  variables: [
    { index: 1, example: 'Maria' },
    { index: 2, example: '12/11' },
  ],
};

describe('TemplatePicker — funções puras', () => {
  it('prévia troca só o que foi preenchido', () => {
    expect(previewTemplate(LEMBRETE.body, ['Ana'])).toBe('Olá Ana, sua coleta é {{2}}.');
  });

  it('pedido só sai com o modelo escolhido e todas as variáveis', () => {
    const key = 'lembrete_coleta|pt_BR';
    expect(templateRequestOf([LEMBRETE], { key, variables: ['Ana'] })).toBeNull();
    expect(templateRequestOf([LEMBRETE], { key, variables: ['Ana', '  '] })).toBeNull();
    expect(templateRequestOf([LEMBRETE], { key, variables: [' Ana ', 'amanhã'] })).toEqual({
      name: 'lembrete_coleta',
      language: 'pt_BR',
      variables: ['Ana', 'amanhã'],
    });
    expect(templateRequestOf([LEMBRETE], { key: '', variables: [] })).toBeNull();
  });
});

describe('Composer — envio por modelo', () => {
  it('janela fechada: botão "Enviar modelo" em destaque, modal com prévia e envio', async () => {
    const onSendTemplate = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer onSend={vi.fn()} whatsappWindow={CLOSED} templates={[LEMBRETE]} onSendTemplate={onSendTemplate} />,
    );
    const button = screen.getByTestId('window-template-button');
    expect(button).toBeEnabled();
    await userEvent.click(button);

    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Enviar' });
    expect(send).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText('Modelo aprovado'), 'lembrete_coleta|pt_BR');
    await userEvent.type(within(dialog).getByLabelText('Variável {{1}}'), 'Ana');
    expect(within(dialog).getByTestId('template-preview')).toHaveTextContent('Olá Ana, sua coleta é {{2}}.');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Variável {{2}}'), 'amanhã');
    await userEvent.click(send);

    expect(onSendTemplate).toHaveBeenCalledWith({
      name: 'lembrete_coleta',
      language: 'pt_BR',
      variables: ['Ana', 'amanhã'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('envio recusado: o modal fica aberto com o que foi digitado', async () => {
    const onSendTemplate = vi.fn().mockRejectedValue(new Error('falhou'));
    render(
      <Composer onSend={vi.fn()} whatsappWindow={CLOSED} templates={[LEMBRETE]} onSendTemplate={onSendTemplate} />,
    );
    await userEvent.click(screen.getByTestId('window-template-button'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Modelo aprovado'), 'lembrete_coleta|pt_BR');
    await userEvent.type(within(dialog).getByLabelText('Variável {{1}}'), 'Ana');
    await userEvent.type(within(dialog).getByLabelText('Variável {{2}}'), 'amanhã');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(onSendTemplate).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByLabelText('Variável {{1}}')).toHaveValue('Ana');
  });

  it('janela aberta: modelo também disponível (secundário); sem modelos aprovados, desabilitado com o motivo', () => {
    const { rerender } = render(
      <Composer onSend={vi.fn()} whatsappWindow={OPEN} templates={[LEMBRETE]} onSendTemplate={vi.fn()} />,
    );
    expect(screen.getByTestId('window-template-button')).toBeEnabled();
    expect(screen.getByLabelText('Mensagem')).toBeEnabled();

    rerender(<Composer onSend={vi.fn()} whatsappWindow={CLOSED} templates={[]} onSendTemplate={vi.fn()} />);
    const button = screen.getByTestId('window-template-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Nenhum modelo aprovado pela Meta para este laboratório.');
  });

  it('lista com erro (Meta fora / sem credencial): aviso visível com "Tentar de novo", não "nenhum modelo"', async () => {
    const onRetry = vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        whatsappWindow={CLOSED}
        templates={[]}
        templatesError
        onRetryTemplates={onRetry}
        onSendTemplate={vi.fn()}
      />,
    );
    expect(screen.getByTestId('templates-error')).toHaveTextContent('Não foi possível carregar os modelos');
    expect(screen.queryByText(/Nenhum modelo aprovado/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('trocar de conversa zera o modelo escolhido', async () => {
    const { rerender } = render(
      <Composer onSend={vi.fn()} draftId="c1" whatsappWindow={CLOSED} templates={[LEMBRETE]} onSendTemplate={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId('window-template-button'));
    await userEvent.selectOptions(
      within(await screen.findByRole('dialog')).getByLabelText('Modelo aprovado'),
      'lembrete_coleta|pt_BR',
    );
    rerender(
      <Composer onSend={vi.fn()} draftId="c2" whatsappWindow={CLOSED} templates={[LEMBRETE]} onSendTemplate={vi.fn()} />,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByTestId('window-template-button'));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Modelo aprovado')).toHaveValue('');
  });
});
