import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/components/ui';

/**
 * PageHeader — docs/frontend/COMPONENTS.md (`layout/`).
 * Título 32px (`text-display`, fonte de título), ações à direita,
 * breadcrumb opcional acima. Em `size="compact"` o título cai para 21px
 * (`text-section`): em tela de painel o maior tipo da página é o NÚMERO,
 * não a palavra que nomeia a tela.
 */

export interface BreadcrumbItem {
  label: string;
  /** Sem `to`, o item é o atual (texto, não link). */
  to?: string;
}

export type PageHeaderSize = 'default' | 'compact';

export interface PageHeaderProps {
  title: string;
  breadcrumb?: BreadcrumbItem[];
  /** Linha de ações alinhada à direita — nunca comprime. */
  actions?: ReactNode;
  /** Uma frase de apoio sob o título. */
  description?: string;
  /**
   * `default` (32px, telas de leitura) ou `compact` (21px, telas de painel —
   * o topo não pode competir com os números que a tela existe para mostrar).
   */
  size?: PageHeaderSize;
  className?: string;
}

export function PageHeader({
  title,
  breadcrumb,
  actions,
  description,
  size = 'default',
  className,
}: PageHeaderProps) {
  const compact = size === 'compact';

  return (
    <header
      className={cn(
        'flex flex-wrap justify-between gap-lg',
        compact ? 'items-center gap-md' : 'items-start',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav aria-label="Trilha de navegação" className="mb-xs">
            <ol className="flex flex-wrap items-center gap-xs font-body text-caption text-neutral-600">
              {breadcrumb.map((item, index) => (
                <li key={`${item.label}-${index}`} className="flex items-center gap-xs">
                  {index > 0 && <span aria-hidden="true">/</span>}
                  {item.to ? (
                    <Link to={item.to} className="text-neutral-700 underline-offset-2 hover:underline">
                      {item.label}
                    </Link>
                  ) : (
                    <span aria-current="page">{item.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        <h1 className={cn('font-heading text-text', compact ? 'text-section' : 'text-display')}>
          {title}
        </h1>

        {description && (
          <p
            className={cn(
              'font-body text-neutral-700',
              compact ? 'text-caption' : 'mt-xs text-body',
            )}
          >
            {description}
          </p>
        )}
      </div>

      {actions && (
        <div style={{ flex: '0 0 auto' }} className="flex items-center gap-sm">
          {actions}
        </div>
      )}
    </header>
  );
}
