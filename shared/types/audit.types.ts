import type { IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

export interface AuditEntry {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
  timestamp: IsoDateTime;
}

export interface ListAuditQuery extends PaginationQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
}

export interface ListAuditResponse {
  entries: AuditEntry[];
  pagination: PaginationMeta;
}
