import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ImageLightbox } from './ImageLightbox';

/**
 * ImageLightbox — tela cheia (CRMLAB-15) com zoom e arraste (CRMLAB-21).
 *
 * O que o teste protege: fechar continua funcionando pelos três caminhos, e o
 * arraste do zoom não fecha a imagem por engano.
 */

beforeAll(() => {
  // jsdom não implementa pointer capture; sem isto todo pointerdown estoura.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();

  // jsdom também não tem PointerEvent — sem ele o fireEvent entrega um Event
  // cru, `clientX` chega undefined e o arraste vira NaN. Um MouseEvent com
  // `pointerId` é o bastante para o componente.
  if (!('PointerEvent' in window)) {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params: MouseEventInit & { pointerId?: number } = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, writable: true });
  }
});

/** Escala aplicada no `transform` inline, para não depender do texto do CSS. */
function scaleOf(image: HTMLElement) {
  return Number(/scale\(([\d.]+)\)/.exec(image.style.transform)?.[1] ?? NaN);
}

describe('ImageLightbox', () => {
  it('src null não renderiza nada', () => {
    render(<ImageLightbox src={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });

  it('fecha por ×, por Esc e por clique fora — mas não por clique na imagem', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ImageLightbox src="blob:foto" onClose={onClose} />);

    await user.click(screen.getByTestId('image-lightbox-image'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('image-lightbox-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('↓ baixa a imagem com o nome original e não fecha o lightbox (CRMLAB-26)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ImageLightbox src="blob:foto" fileName="pedido médico.jpg" onClose={onClose} />);

    const link = screen.getByRole('link', { name: 'Baixar imagem' });
    expect(link).toHaveAttribute('href', 'blob:foto');
    expect(link).toHaveAttribute('download', 'pedido médico.jpg');

    await user.click(link);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sem nome de arquivo o download ainda acontece — atributo nunca some', () => {
    render(<ImageLightbox src="blob:foto" onClose={vi.fn()} />);

    // `download` ausente transformaria o ↓ em navegação para o blob.
    expect(screen.getByRole('link', { name: 'Baixar imagem' })).toHaveAttribute('download');
  });

  it('botões + e − aproximam e afastam; reset volta ao tamanho original (CRMLAB-21)', async () => {
    const user = userEvent.setup();
    render(<ImageLightbox src="blob:foto" onClose={vi.fn()} />);
    const image = screen.getByTestId('image-lightbox-image');

    expect(scaleOf(image)).toBe(1);
    // No tamanho original não há o que afastar nem o que resetar.
    expect(screen.getByRole('button', { name: 'Afastar' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Tamanho original' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Aproximar' }));
    expect(scaleOf(image)).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: 'Tamanho original' }));
    expect(scaleOf(image)).toBe(1);
  });

  it('duplo clique aproxima e um segundo duplo clique volta ao original', async () => {
    const user = userEvent.setup();
    render(<ImageLightbox src="blob:foto" onClose={vi.fn()} />);
    const image = screen.getByTestId('image-lightbox-image');

    await user.dblClick(image);
    expect(scaleOf(image)).toBeGreaterThan(1);

    await user.dblClick(image);
    expect(scaleOf(image)).toBe(1);
  });

  it('arrastar a imagem ampliada move o enquadramento e não fecha o lightbox', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ImageLightbox src="blob:foto" onClose={onClose} />);
    const image = screen.getByTestId('image-lightbox-image');

    await user.click(screen.getByRole('button', { name: 'Aproximar' }));

    fireEvent.pointerDown(image, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(image.style.transform).toContain('translate(60px, 40px)');

    // O `click` que o browser dispara ao soltar o arraste borbulha até o
    // backdrop: ele não pode ser lido como "clique fora".
    fireEvent.click(screen.getByTestId('image-lightbox-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('setas entre imagens (CRMLAB-64, D-244)', () => {
    it('sem onPrev/onNext não há seta — imagem só', () => {
      render(<ImageLightbox src="blob:foto" onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Imagem anterior' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Próxima imagem' })).not.toBeInTheDocument();
    });

    it('só a seta do lado que tem imagem aparece; clicar navega e não fecha', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onNext = vi.fn();
      render(<ImageLightbox src="blob:foto" onClose={onClose} onNext={onNext} />);

      expect(screen.queryByRole('button', { name: 'Imagem anterior' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Próxima imagem' }));
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('← e → navegam; Esc continua fechando', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onPrev = vi.fn();
      const onNext = vi.fn();
      render(<ImageLightbox src="blob:foto" onClose={onClose} onPrev={onPrev} onNext={onNext} />);

      await user.keyboard('{ArrowLeft}');
      await user.keyboard('{ArrowRight}{ArrowRight}');
      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(2);
      expect(onClose).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('sem imagem do lado, a tecla não faz nada (não dá a volta)', async () => {
      const user = userEvent.setup();
      const onNext = vi.fn();
      render(<ImageLightbox src="blob:foto" onClose={vi.fn()} onNext={onNext} />);

      await user.keyboard('{ArrowLeft}');
      expect(onNext).not.toHaveBeenCalled();
    });

    it('trocar de imagem zera zoom; o ↓ baixa a da tela com o nome dela', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <ImageLightbox src="blob:frente" fileName="frente.jpg" onClose={vi.fn()} onNext={vi.fn()} />,
      );
      await user.click(screen.getByRole('button', { name: 'Aproximar' }));
      expect(scaleOf(screen.getByTestId('image-lightbox-image'))).toBeGreaterThan(1);

      rerender(
        <ImageLightbox src="blob:verso" fileName="verso.jpg" onClose={vi.fn()} onPrev={vi.fn()} />,
      );
      expect(scaleOf(screen.getByTestId('image-lightbox-image'))).toBe(1);
      const link = screen.getByRole('link', { name: 'Baixar imagem' });
      expect(link).toHaveAttribute('href', 'blob:verso');
      expect(link).toHaveAttribute('download', 'verso.jpg');
    });

    it('mostra cabeçalho e legenda; clicar neles não fecha', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <ImageLightbox
          src="blob:foto"
          onClose={onClose}
          title="Maria Silva · 27/09/2026 14:32"
          caption="Pedido do Dr. Silva"
        />,
      );

      expect(screen.getByTestId('image-lightbox-title')).toHaveTextContent(
        'Maria Silva · 27/09/2026 14:32',
      );
      await user.click(screen.getByTestId('image-lightbox-caption'));
      expect(screen.getByTestId('image-lightbox-caption')).toHaveTextContent('Pedido do Dr. Silva');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('aberto sem src mostra carregando (ou o erro) no lugar da imagem, sem ↓', () => {
      const { rerender } = render(
        <ImageLightbox src={null} open loading onClose={vi.fn()} onPrev={vi.fn()} />,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Carregando imagem…');
      expect(screen.queryByTestId('image-lightbox-image')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Baixar imagem' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Imagem anterior' })).toBeInTheDocument();

      rerender(<ImageLightbox src={null} open error onClose={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('Não foi possível carregar a imagem');
    });

    it('pré-carrega as vizinhas em <img> escondidos', () => {
      const { container } = render(
        <ImageLightbox src="blob:foto" onClose={vi.fn()} preload={['blob:antes', 'blob:depois']} />,
      );
      const hidden = [...container.querySelectorAll('img[aria-hidden="true"]')].map((img) =>
        img.getAttribute('src'),
      );
      expect(hidden).toEqual(['blob:antes', 'blob:depois']);
    });
  });
});
