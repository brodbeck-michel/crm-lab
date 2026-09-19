import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';

export interface ImageLightboxProps {
  /** URL da imagem a exibir em tela cheia. `null`/vazio não renderiza nada. */
  src: string | null;
  /** Nome de arquivo sugerido para o download. */
  fileName?: string;
  onClose: () => void;
}

/** Limites do zoom (CRMLAB-21). 1 = imagem inteira na tela; 6 lê letra miúda de receita. */
const MIN_SCALE = 1;
const MAX_SCALE = 6;
/** Passo dos botões + e −. */
const BUTTON_STEP = 1.4;
/** Zoom do duplo clique, quando a imagem está no tamanho original. */
const DOUBLE_CLICK_SCALE = 2.5;
/** Arraste menor que isto é clique, não pan — senão soltar o mouse fecharia o lightbox. */
const DRAG_SLOP_PX = 4;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Aplica um fator de zoom mantendo parado o ponto que está sob o cursor (ou sob
 * o meio da pinça). Sem isso, aproximar num canto joga o trecho de interesse
 * para fora da tela.
 *
 * O transform é `translate(x, y) scale(s)` com origem no centro: um ponto a
 * `v` do centro aparece em `C + t + s·v`. Fixar esse ponto dá
 * `t' = (1 − k)·(âncora − C) + k·t`, com `k = s'/s`.
 */
function zoomAt(current: Transform, factor: number, anchorX: number, anchorY: number): Transform {
  const scale = clampScale(current.scale * factor);
  if (scale === current.scale) return current;
  if (scale === MIN_SCALE) return IDENTITY;

  const k = scale / current.scale;
  return {
    scale,
    x: (1 - k) * anchorX + k * current.x,
    y: (1 - k) * anchorY + k * current.y,
  };
}

/**
 * ImageLightbox — visualização em tela cheia de uma imagem de anexo
 * (CRMLAB-15), com zoom e arraste (CRMLAB-21). Referência de comportamento:
 * WhatsApp Web.
 *
 * Mais leve que `Modal`: sem cartão, sem título, sem foco preso — é só a
 * imagem sobre um backdrop escuro. Fecha por ×, Esc e clique fora da imagem.
 *
 * Zoom pela roda do mouse, pela pinça, pelos botões + / − e por duplo clique;
 * volta ao tamanho original no botão de reset ou em outro duplo clique. Com a
 * imagem ampliada, arrastar navega pelas partes fora da tela — e o arraste
 * terminado fora da imagem NÃO fecha o lightbox.
 */
export function ImageLightbox({ src, fileName, onClose }: ImageLightboxProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const isZoomed = transform.scale > MIN_SCALE;

  /** Ponteiros em cima da imagem: 1 = arraste, 2 = pinça. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  /** Distância entre os dois dedos no quadro anterior da pinça. */
  const pinchDistanceRef = useRef<number | null>(null);
  /** Houve arraste de verdade desde o `pointerdown`? Então o clique não fecha. */
  const draggedRef = useRef(false);

  /** Centro do backdrop — origem do `scale`, âncora de todo cálculo de zoom. */
  const centerOf = useCallback((event: { clientX: number; clientY: number }) => {
    const rect = backdropRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: event.clientX - (rect.left + rect.width / 2),
      y: event.clientY - (rect.top + rect.height / 2),
    };
  }, []);

  // Cada imagem abre no tamanho original — o zoom da foto anterior não vaza.
  useEffect(() => {
    setTransform(IDENTITY);
    pointersRef.current.clear();
    pinchDistanceRef.current = null;
  }, [src]);

  useEffect(() => {
    if (!src) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [src, onClose]);

  // `wheel` precisa de listener não-passivo: o React registra o dele como
  // passivo e o `preventDefault()` lá dentro é ignorado — aí a página atrás
  // rola enquanto o atendente tenta aproximar a imagem.
  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop || !src) return;

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const anchor = centerOf(event);
      // Passo proporcional ao giro: trackpad (delta pequeno) fica suave,
      // roda de mouse (delta grande) chega rápido onde quer.
      const factor = Math.exp(-event.deltaY / 400);
      setTransform((current) => zoomAt(current, factor, anchor.x, anchor.y));
    }

    backdrop.addEventListener('wheel', onWheel, { passive: false });
    return () => backdrop.removeEventListener('wheel', onWheel);
  }, [src, centerOf]);

  function zoomByButton(factor: number) {
    // Botão não tem cursor para ancorar: aproxima pelo centro da tela.
    setTransform((current) => zoomAt(current, factor, 0, 0));
  }

  function onPointerDown(event: React.PointerEvent<HTMLImageElement>) {
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    draggedRef.current = false;
    if (pointersRef.current.size === 2) pinchDistanceRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLImageElement>) {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const last = pinchDistanceRef.current;
      pinchDistanceRef.current = distance;
      if (last && distance > 0) {
        draggedRef.current = true;
        const anchor = centerOf({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        setTransform((current) => zoomAt(current, distance / last, anchor.x, anchor.y));
      }
      return;
    }

    if (!isZoomed) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) draggedRef.current = true;
    setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  function onPointerUp(event: React.PointerEvent<HTMLImageElement>) {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchDistanceRef.current = null;
  }

  if (!src) return null;

  return (
    <div
      ref={backdropRef}
      data-testid="image-lightbox-backdrop"
      onClick={() => {
        // Soltar o arraste fora da imagem não é "clique fora": não fecha.
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        onClose();
      }}
      className="fixed inset-0 z-50 flex touch-none items-center justify-center overflow-hidden bg-backdrop p-lg"
    >
      <img
        src={src}
        alt=""
        data-testid="image-lightbox-image"
        draggable={false}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          const anchor = centerOf(event);
          setTransform((current) =>
            current.scale > MIN_SCALE
              ? IDENTITY
              : zoomAt(current, DOUBLE_CLICK_SCALE, anchor.x, anchor.y),
          );
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
        className={cn(
          'max-h-[86vh] max-w-full select-none rounded-lg object-contain shadow-lg',
          isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
        )}
      />

      <div
        className="absolute right-lg top-lg flex items-center gap-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Afastar"
          disabled={!isZoomed}
          onClick={() => zoomByButton(1 / BUTTON_STEP)}
          className={cn(
            'flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-pill',
            'border-none bg-neutral-100 font-body text-neutral-700 hover:bg-neutral-200',
            'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-neutral-100',
          )}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Aproximar"
          disabled={transform.scale >= MAX_SCALE}
          onClick={() => zoomByButton(BUTTON_STEP)}
          className={cn(
            'flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-pill',
            'border-none bg-neutral-100 font-body text-neutral-700 hover:bg-neutral-200',
            'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-neutral-100',
          )}
        >
          +
        </button>
        {isZoomed && (
          <button
            type="button"
            aria-label="Tamanho original"
            onClick={() => setTransform(IDENTITY)}
            className={cn(
              'flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-pill',
              'border-none bg-neutral-100 font-body text-neutral-700 hover:bg-neutral-200',
            )}
          >
            ⤢
          </button>
        )}
        <a
          href={src}
          download={fileName}
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
