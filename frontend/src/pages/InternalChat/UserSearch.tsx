import { useMemo, useState } from 'react';
import type { ChatDirectoryUser } from '@crm-lab/shared';
import { Chip, SearchInput, cn } from '@/components/ui';

/**
 * Campo de busca de usuário no topo do Chat Interno (PAGES.md §9, D-101) —
 * substitui a lista fixa de usuários (feedback: ocupava espaço demais junto
 * dos canais). Fica SÓ com Canais/Mensagens diretas na barra lateral; buscar
 * e clicar um resultado abre a DM, que passa a aparecer no grupo "Mensagens
 * diretas" de `ChannelList` — a busca em si não lista nada permanentemente.
 *
 * Filtro é local (sem endpoint de busca): `GET /internal-chat/users` não pagina
 * nem busca de propósito (laboratório pequeno, API_CONTRACTS.md §3b) — a lista
 * inteira já vem carregada, igual ao padrão de `quick-replies` (filtra em
 * memória, ver `Composer`).
 */

export interface UserSearchProps {
  users: ChatDirectoryUser[];
  onSelectUser: (userId: string) => void;
  isLoading: boolean;
  isError: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrador',
  manager: 'Gestor',
  attendant: 'Atendente',
};

export function UserSearch({ users, onSelectUser, isLoading, isError }: UserSearchProps) {
  const [term, setTerm] = useState('');
  // Remonta o `SearchInput` (não-controlado) para limpar o campo após escolher
  // um resultado — sem isso o texto digitado ficaria preso na tela.
  const [resetKey, setResetKey] = useState(0);

  const results = useMemo(() => {
    const query = term.trim().toLowerCase();
    if (query.length === 0) return [];
    return users.filter((user) => user.name.toLowerCase().includes(query));
  }, [users, term]);

  function handleSelect(userId: string) {
    setTerm('');
    setResetKey((key) => key + 1);
    onSelectUser(userId);
  }

  return (
    <div className="flex flex-col gap-xs border-b border-neutral-300 px-sm py-sm">
      <SearchInput
        key={resetKey}
        placeholder={isError ? 'Busca indisponível' : 'Buscar usuário…'}
        aria-label="Buscar usuário para iniciar conversa direta"
        onSearch={setTerm}
        disabled={isLoading || isError}
      />

      {term.trim().length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-xs p-0">
          {results.length === 0 ? (
            <li className="px-md py-sm font-body text-caption text-neutral-600">
              Nenhum usuário encontrado
            </li>
          ) : (
            results.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  data-testid="user-search-result"
                  onClick={() => handleSelect(user.id)}
                  className={cn(
                    'flex w-full items-center gap-sm rounded-md px-md py-sm text-left',
                    'font-body text-label text-text transition-colors hover:bg-neutral-200',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{user.name}</span>
                  <Chip>{ROLE_LABELS[user.role] ?? user.role}</Chip>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
