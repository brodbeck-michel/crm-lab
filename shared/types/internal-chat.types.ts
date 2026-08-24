import type { IsoDateTime, PaginationMeta } from './api.types.js';

export interface Channel {
  id: string;
  key: string;
  name: string;
  kind: 'channel' | 'dm';
  unreadCount: number;
  lastMessageAt: IsoDateTime | null;
}

export interface InternalMessage {
  id: string;
  channelId: string;
  senderId: string | null;
  senderName: string;
  content: string;
  /** Proposta anexada renderiza como ProposalCard clicavel. */
  attachedProposalId: string | null;
  isSystem: boolean;
  createdAt: IsoDateTime;
}

export interface ListChannelsResponse {
  channels: Channel[];
}

export interface ListInternalMessagesResponse {
  messages: InternalMessage[];
  pagination: PaginationMeta;
}

export interface SendInternalMessageRequest {
  content: string;
  attachedProposalId?: string | null;
}
