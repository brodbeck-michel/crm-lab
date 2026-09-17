import { useEffect } from 'react';
import { cn } from '@/components/ui/cn';

export interface ImageLightboxProps {
  /** URL da imagem a exibir em tela cheia. `null`/vazio não renderiza nada. */
  src: string | null;
  /** Nome de arquivo sugerido para o download. */
  fileName?: string;
  onClose: () => void;
}

/**
 * ImageLightbox — visualização em tela cheia de uma imagem de anexo
 * (CRMLAB-15), referência de comportamento: WhatsApp Web.
 *
 * Mais leve que `Modal`: sem cartão, sem título, sem foco preso — é só a
 * imagem sobre um backdrop escuro. Fecha por ×, Esc e clique fora da imagem.
 */
export function ImageLightbox({ src, fileName, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!src) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      data-testid="image-lightbox-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop p-lg"
    >
      <img
        src={src}
        alt=""
        onClick={(event) => event.stopPropagation()}
        className="max-h-[86vh] max-w-full rounded-lg object-contain shadow-lg"
      />

      <div className="absolute right-lg top-lg flex items-center gap-sm">
        <a
          href={src}
          download={fileName}
          onClick={(event) => event.stopPropagation()}
          aria-label="Baixar imagem"
          className={cn(
            'flex h-[36px] w-[36px] items-center justify-center rounded-pill border-none',
            'bg-neutral-100 font-body text-neutral-700 no-underline hover:bg-neutral-200',
          )}
        >
          ↓
        </a>
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          className={cn(
            'flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-pill',
            'border-none bg-neutral-100 font-body text-neutral-700 hover:bg-neutral-200',
          )}
        >
          ×
        </button>
      </div>
    </div>
  );
}
