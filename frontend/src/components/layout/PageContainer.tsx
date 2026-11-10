import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface PageContainerProps {
  children: ReactNode;
  className?: string;
  /**
   * Tela que precisa da altura e da largura inteiras (quadro do funil): mesmas
   * margens do padrão, sem teto de largura e com `h-full`.
   */
  fill?: boolean;
}

/** Margens do padrão de página — as mesmas em TODA tela (CRMLAB-145, D-317). */
export const PAGE_MAX_WIDTH = 1600;
export const PAGE_PADDING = '28px 32px 48px';

/**
 * Contêiner ÚNICO de página (PAGES.md §3, CRMLAB-145 / D-317): `max-width
 * 1600px`, `padding 28px 32px 48px`. Toda tela usa este contêiner, então o
 * título começa no mesmo ponto e o conteúdo ocupa a mesma largura em qualquer
 * tela — antes havia três larguras (1180, 1440 e "encostado na borda").
 * Texto corrido e formulário limitam a PRÓPRIA largura por dentro (ex.:
 * `max-w-3xl`), alinhados à esquerda. Só inbox, orçamento, chat e agenda
 * (telas de painel cheio) ficam fora.
 */
export function PageContainer({ children, className, fill = false }: PageContainerProps) {
  return (
    <div
      style={{ maxWidth: fill ? undefined : PAGE_MAX_WIDTH, padding: PAGE_PADDING }}
      className={cn('flex w-full min-w-0 flex-col gap-lg', fill && 'h-full', className)}
    >
      {children}
    </div>
  );
}
