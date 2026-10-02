import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MEDIA_BYTES } from '@crm-lab/shared';
import { AttachmentPreview } from './AttachmentPreview';
import {
  DOCUMENT_ACCEPT,
  createAttachmentDraft,
  formatBytes,
  validateAttachment,
} from './attachment-draft';
import type { AttachmentDraft } from './attachment-draft';

/**
 * Prévia de anexos (CRMLAB-69, D-232): miniaturas, remover, legenda por
 * arquivo, × descarta, aviso de inválido e object URL revogado.
 */

function file(name: string, type: string, size = 10): File {
  const created = new File(['x'.repeat(Math.min(size, 64))], name, { type });
  if (size > 64) Object.defineProperty(created, 'size', { value: size });
  return created;
}

let urls = 0;
beforeEach(() => {
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:img-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

/** Dono de estado mínimo, como o `ConversationPanel`. */
function Harness({
  files,
  onSend,
  onClose,
}: {
  files: File[];
  onSend: (items: AttachmentDraft[]) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState(() => files.map(createAttachmentDraft));
  const [open, setOpen] = useState(true);
  if (!open) return <p>fechada</p>;
  return (
    <AttachmentPreview
      items={items}
      onCaptionChange={(id, caption) =>
        setItems((list) => list.map((item) => (item.id === id ? { ...item, caption } : item)))
      }
      onRemove={(id) => setItems((list) => list.filter((item) => item.id !== id))}
      onAdd={(added) => setItems((list) => [...list, ...added.map(createAttachmentDraft)])}
      onSend={() => onSend(items)}
      onClose={() => {
        onClose?.();
        setOpen(false);
      }}
    />
  );
}

describe('attachment-draft — mesmas regras do backend (D-169/D-232)', () => {
  it('tipo fora da allow-list, vazio e acima de 15 MB avisam; o resto passa', () => {
    expect(validateAttachment(file('a.png', 'image/png'))).toBeNull();
    expect(validateAttachment(file('a.pdf', 'application/pdf'))).toBeNull();
    expect(validateAttachment(file('a.svg', 'image/svg+xml'))).toBe(
      'Tipo de arquivo não permitido',
    );
    expect(validateAttachment(file('a.exe', ''))).toBe('Tipo de arquivo não permitido');
    expect(validateAttachment(file('a.png', 'image/png', 0))).toBe('Arquivo vazio');
    expect(validateAttachment(file('a.pdf', 'application/pdf', MAX_MEDIA_BYTES + 1))).toBe(
      'Arquivo acima de 15 MB',
    );
    expect(validateAttachment(file('a.pdf', 'application/pdf', MAX_MEDIA_BYTES))).toBeNull();
  });

  it('formatBytes e o accept do Documento (a allow-list inteira)', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(340 * 1024)).toBe('340 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1,3 MB');
    expect(DOCUMENT_ACCEPT).toContain('application/pdf');
    expect(DOCUMENT_ACCEPT).not.toContain('svg');
  });
});

describe('AttachmentPreview', () => {
  it('3 arquivos = 3 miniaturas; remover 1 envia só os 2, na ordem', async () => {
    const onSend = vi.fn();
    const a = file('a.png', 'image/png');
    const b = file('b.pdf', 'application/pdf');
    const c = file('c.png', 'image/png');
    render(<Harness files={[a, b, c]} onSend={onSend} />);

    expect(screen.getAllByTestId('attachment-thumb')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Remover b.pdf' }));
    expect(screen.getAllByTestId('attachment-thumb')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSend.mock.calls[0]?.[0].map((item: AttachmentDraft) => item.file)).toEqual([a, c]);
  });

  it('imagem aparece grande; documento mostra ícone + nome + tamanho', async () => {
    render(
      <Harness
        files={[file('print.png', 'image/png'), file('pedido.pdf', 'application/pdf', 2048)]}
        onSend={vi.fn()}
      />,
    );
    const preview = screen.getByRole('dialog', { name: 'Prévia do anexo' });
    expect(within(preview).getByRole('img', { name: 'print.png' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Ver pedido.pdf' }));
    expect(within(preview).queryByRole('img', { name: 'pedido.pdf' })).not.toBeInTheDocument();
    expect(within(preview).getAllByText('pedido.pdf').length).toBeGreaterThan(0);
    expect(within(preview).getByText('2 KB')).toBeInTheDocument();
  });

  it('uma legenda por arquivo; Enter envia e Shift+Enter quebra linha', async () => {
    const onSend = vi.fn();
    render(
      <Harness files={[file('a.png', 'image/png'), file('b.png', 'image/png')]} onSend={onSend} />,
    );
    const caption = screen.getByLabelText('Adicionar legenda');
    expect(caption).toHaveFocus();
    await userEvent.type(caption, 'primeira{Shift>}{Enter}{/Shift}linha');
    await userEvent.click(screen.getByRole('button', { name: 'Ver b.png' }));
    expect(screen.getByLabelText('Adicionar legenda')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Adicionar legenda'), 'segunda{Enter}');

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0].map((item: AttachmentDraft) => item.caption)).toEqual([
      'primeira\nlinha',
      'segunda',
    ]);
  });

  it('× descarta sem enviar; Esc também fecha', async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <Harness files={[file('a.png', 'image/png')]} onSend={onSend} onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Descartar anexos' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    unmount();

    render(<Harness files={[file('a.png', 'image/png')]} onSend={onSend} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('arquivo inválido avisa na prévia; só com inválidos o Enviar fica desligado', async () => {
    render(
      <Harness
        files={[
          file('grande.pdf', 'application/pdf', MAX_MEDIA_BYTES + 1),
          file('x.svg', 'image/svg+xml'),
        ]}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Arquivo acima de 15 MB');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Ver x.svg' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tipo de arquivo não permitido');
  });

  it('com um válido e um inválido, envia (quem monta filtra os válidos)', async () => {
    const onSend = vi.fn();
    render(
      <Harness
        files={[file('a.png', 'image/png'), file('x.svg', 'image/svg+xml')]}
        onSend={onSend}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('+ adiciona mais arquivos à faixa', async () => {
    render(<Harness files={[file('a.png', 'image/png')]} onSend={vi.fn()} />);
    await userEvent.upload(screen.getByTestId('attachment-add-input'), [
      file('b.pdf', 'application/pdf'),
      file('c.pdf', 'application/pdf'),
    ]);
    expect(screen.getAllByTestId('attachment-thumb')).toHaveLength(3);
  });

  it('remover o último arquivo fecha a prévia', async () => {
    const onClose = vi.fn();
    render(<Harness files={[file('a.png', 'image/png')]} onSend={vi.fn()} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover a.png' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('object URL é revogado ao remover e ao fechar', async () => {
    render(
      <Harness files={[file('a.png', 'image/png'), file('b.png', 'image/png')]} onSend={vi.fn()} />,
    );
    const created = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value);
    expect(created.length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Remover b.png' }));
    await userEvent.click(screen.getByRole('button', { name: 'Descartar anexos' }));
    expect(screen.getByText('fechada')).toBeInTheDocument();
    const all = vi.mocked(URL.createObjectURL).mock.results.map((result) => result.value);
    const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map((call) => call[0]);
    expect(new Set(revoked)).toEqual(new Set(all));
  });
});
