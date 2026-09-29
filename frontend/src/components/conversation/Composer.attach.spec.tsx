import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

/**
 * Clipe com menu e Ctrl+V de arquivo (CRMLAB-69, D-232).
 */

function pasteEvent(field: HTMLElement, data: { files?: File[]; text?: string }) {
  const files = data.files ?? [];
  return fireEvent.paste(field, {
    clipboardData: {
      files,
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      types: files.length > 0 ? ['Files'] : ['text/plain'],
      getData: () => data.text ?? '',
    },
  });
}

describe('Composer — anexos (CRMLAB-69)', () => {
  it('o clipe abre o menu "Fotos e vídeos" / "Documento" e avisa o clique', async () => {
    const onAttachClick = vi.fn();
    render(<Composer onSend={vi.fn()} onPickFiles={vi.fn()} onAttachClick={onAttachClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Anexar arquivo' }));
    expect(onAttachClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Fotos e vídeos' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Documento' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('os dois seletores aceitam vários arquivos, cada um com o seu accept', () => {
    render(<Composer onSend={vi.fn()} onPickFiles={vi.fn()} />);
    const media = screen.getByTestId('attach-media-input');
    const documentInput = screen.getByTestId('attach-document-input');
    expect(media).toHaveAttribute('multiple');
    expect(media).toHaveAttribute('accept', 'image/*,video/*');
    expect(documentInput).toHaveAttribute('multiple');
    expect(documentInput.getAttribute('accept')).toContain('application/pdf');
  });

  it('escolher arquivos entrega TODOS por onPickFiles (não envia nada sozinho)', async () => {
    const onPickFiles = vi.fn();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onPickFiles={onPickFiles} />);
    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByTestId('attach-media-input'), [a, b]);
    expect(onPickFiles).toHaveBeenCalledWith([a, b]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Ctrl+V de um print entrega a imagem e não cola nada no campo', () => {
    const onPickFiles = vi.fn();
    render(<Composer onSend={vi.fn()} onPickFiles={onPickFiles} />);
    const field = screen.getByLabelText('Mensagem');
    const print = new File(['png'], 'image.png', { type: 'image/png' });

    const notCancelled = pasteEvent(field, { files: [print] });
    expect(notCancelled).toBe(false);
    expect(onPickFiles).toHaveBeenCalledWith([print]);
    expect(field).toHaveValue('');
  });

  it('colar TEXTO continua colando texto normalmente', async () => {
    const onPickFiles = vi.fn();
    render(<Composer onSend={vi.fn()} onPickFiles={onPickFiles} />);
    const field = screen.getByLabelText('Mensagem');
    await userEvent.click(field);
    await userEvent.paste('Bom dia, segue o pedido');
    expect(field).toHaveValue('Bom dia, segue o pedido');
    expect(onPickFiles).not.toHaveBeenCalled();
    // e o evento de texto não é cancelado
    expect(pasteEvent(field, { text: 'x' })).toBe(true);
  });

  it('sem onPickFiles, nem clipe nem colar arquivo', () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Anexar arquivo' })).not.toBeInTheDocument();
    const print = new File(['png'], 'image.png', { type: 'image/png' });
    expect(pasteEvent(screen.getByLabelText('Mensagem'), { files: [print] })).toBe(true);
  });
});
