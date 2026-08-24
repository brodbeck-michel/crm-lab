import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/components/ui';

/**
 * PageHeader — docs/frontend/COMPONENTS.md (`layout/`).
 * Título 32px (`text-display`, fonte de título), ações à direita,
 * breadcrumb opcional acima.
 */

export interface BreadcrumbItem {
  label: string;
  /** Sem `to`, o item é o atual (texto, não link). */
  to?: string;
}

export interface PageHeaderProps {
  title: string;
  breadcrumb?: BreadcrumbItem[];
  /** Linha de ações alinhada à direita — nunca comprime. */
  actions?: ReactNode;
  /** Uma frase de apoio sob o título. */
  description?: string;
  className?: string;
}

export function PageHeader({
  title,
  breadcrumb,
  actions,
  description,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-lg', className)}>
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

        <h1 className="font-heading text-display text-text">{title}</h1>

        {description && (
          <p className="mt-xs font-body text-body text-neutral-700">{description}</p>
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
