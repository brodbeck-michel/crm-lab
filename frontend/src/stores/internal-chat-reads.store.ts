import { create } from 'zustand';
import { channelReadUpTo } from '@crm-lab/shared';
import type { InternalChannelReadState, WsEventPayloads } from '@crm-lab/shared';

/**
 * Leituras do chat interno que chegaram pelo WS `internal_chat.channel_read`
 * (CRMLAB-123, D-301) — só em memória, por canal e por leitor.
 *
 * Por que um store e não `invalidateQueries`: num canal comum o evento vai para
 * o TENANT INTEIRO a cada leitura de qualquer pessoa. Refazer `GET .../messages`
 * em cada aba de cada usuário a cada leitura recriaria a tempestade de
 * requisições do CRMLAB-122 (429). O payload já traz o "lido até" do leitor;
 * a tela junta isto ao `readState` do último GET com `mergeReadState` — zero
 * requisição, com a aba visível ou escondida. Mesma exceção ao "sempre
 * invalidate" que a presença do paciente (`presence.store`, D-226).
 */

export interface ChannelReadEntry {
  readUpTo: string | null;
  lastReadAt: string;
}

export interface InternalChatReadsState {
  /** `channelId` → `userId` → a leitura mais recente recebida. */
  byChannel: Record<string, Record<string, ChannelReadEntry>>;
  applyRead: (read: WsEventPayloads['internal_chat.channel_read']) => void;
  clear: () => void;
}

function isNewer(candidate: string, current: string | null | undefined): boolean {
  if (!current) return true;
  return Date.parse(candidate) > Date.parse(current);
}

export const useInternalChatReadsStore = create<InternalChatReadsState>((set) => ({
  byChannel: {},
  applyRead: ({ channelId, userId, readUpTo, lastReadAt }) =>
    set((state) => {
      const channel = state.byChannel[channelId] ?? {};
      // Evento fora de ordem (reconexão, duas abas) não faz o tique voltar.
      if (!isNewer(lastReadAt, channel[userId]?.lastReadAt)) return state;
      return {
        byChannel: {
          ...state.byChannel,
          [channelId]: { ...channel, [userId]: { readUpTo, lastReadAt } },
        },
      };
    }),
  clear: () => set({ byChannel: {} }),
}));

/**
 * `readState` do GET + leituras do WS: vale, por leitor, a de `lastReadAt` mais
 * recente. Leitor que não está em `readers` (quem pergunta, usuário novo) é
 * ignorado — a lista de membros é a do servidor (D-300).
 */
export function mergeReadState(
  readState: InternalChannelReadState | null,
  live: Record<string, ChannelReadEntry> | undefined,
): InternalChannelReadState | null {
  if (!readState || !live) return readState;
  let changed = false;
  const readers = readState.readers.map((reader) => {
    const entry = live[reader.userId];
    if (!entry || !isNewer(entry.lastReadAt, reader.lastReadAt)) return reader;
    changed = true;
    return { ...reader, readUpTo: entry.readUpTo, lastReadAt: entry.lastReadAt };
  });
  if (!changed) return readState;
  return { readUpTo: channelReadUpTo(readers), readers };
}
