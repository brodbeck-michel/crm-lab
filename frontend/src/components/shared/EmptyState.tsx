import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** Frase curta — ex.: "Nenhum exame ainda". Nunca área em branco. */
  message: string;
  /** Linha auxiliar opcional explicando o próximo passo. */
  hint?: string;
  /** Ação opcional (normalmente um Button secundário). */
  action?: ReactNode;
}

/** Vazio com frase curta centrada em neutral-600 (DESIGN_TOKENS.md §Estados). */
export function EmptyState({ message, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-md px-xl py-[40px] text-center">
      <p className="m-0 font-body text-label text-neutral-600">{message}</p>
      {hint && <p className="m-0 font-body text-caption text-neutral-600">{hint}</p>}
      {action}
    </div>
  );
}
