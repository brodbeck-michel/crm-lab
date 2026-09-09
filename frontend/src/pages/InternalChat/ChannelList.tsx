import type { Channel } from '@crm-lab/shared';
import { Badge, Button, cn } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { formatRelativeDate } from '@/lib/format';

/**
 * Coluna 1 do Chat Interno — PAGES.md §9 ("Lista de canais + DMs").
 *
 * Componente burro: não conhece a API. Recebe os canais já carregados e
 * devolve a seleção. Os três estados (carregando · vazio · erro) são
 * obrigatórios — nunca área em branco (DESIGN_TOKENS.md §Estados).
 */

export interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (channelId: string) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function ChannelButton({
  channel,
  selected,
  onSelect,
}: {
  channel: Channel;
  selected: boolean;
  onSelect: (channelId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="channel-item"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(channel.id)}
        className={cn(
          'flex w-full items-center gap-sm rounded-md px-md py-sm text-left',
          'font-body text-label text-text transition-colors',
          selected ? 'bg-accent-100 font-semibold' : 'hover:bg-neutral-200',
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {channel.kind === 'dm' ? (channel.otherUserName ?? channel.name) : channel.name}
        </span>

        {channel.lastMessageAt && (
          <span className="flex-[0_0_auto] font-body text-micro tracking-normal text-neutral-600">
            {formatRelativeDate(channel.lastMessageAt)}
          </span>
        )}

        <Badge
          count={channel.unreadCount}
          label={`${channel.unreadCount} mensagens não lidas em ${channel.name}`}
        />
      </button>
    </li>
  );
}

function Group({
  title,
  channels,
  selectedId,
  onSelect,
}: {
  title: string;
  channels: Channel[];
  selectedId: string | null;
  onSelect: (channelId: string) => void;
}) {
  if (channels.length === 0) return null;

  return (
    <section className="flex flex-col gap-xs px-sm py-sm">
      <h3 className="m-0 px-md font-body text-micro font-bold uppercase text-neutral-600">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-xs p-0">
        {channels.map((channel) => (
          <ChannelButton
            key={channel.id}
            channel={channel}
            selected={channel.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

export function ChannelList({
  channels,
  selectedId,
  onSelect,
  isLoading,
  isError,
  onRetry,
}: ChannelListProps) {
  if (isError) {
    return (
      <EmptyState
        message="Não foi possível carregar os canais"
        hint="A conexão pode ter caído no meio do caminho."
        action={
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Tentar novamente
          </Button>
        }
      />
    );
  }

  if (isLoading) {
    return (
      <p role="status" className="m-0 px-lg py-lg font-body text-caption text-neutral-600">
        Carregando canais…
      </p>
    );
  }

  if (channels.length === 0) {
    return (
      <EmptyState
        message="Nenhum canal ainda"
        hint="Os canais padrão nascem no onboarding do laboratório."
      />
    );
  }

  return (
    <nav aria-label="Canais internos" className="flex flex-col">
      <Group
        title="Canais"
        channels={channels.filter((channel) => channel.kind === 'channel')}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <Group
        title="Mensagens diretas"
        channels={channels.filter((channel) => channel.kind === 'dm')}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </nav>
  );
}
