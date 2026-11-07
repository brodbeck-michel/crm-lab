/**
 * A Cloud API pode cair no driver mock? (CRMLAB-138, D-308 item 5, 05/11/2026)
 *
 * So sem `WHATSAPP_API_URL`, e em `NODE_ENV=production` so com
 * `WHATSAPP_CLOUD_API_MOCK=true` — ligado apenas na hml (laboratorio de
 * treinamento). Producao sem a URL da Meta nao "envia" em silencio: recusa com
 * `CHANNEL_CLOUD_API_UNAVAILABLE`.
 */
import { env } from '../config/env.js';

export function cloudApiMockAllowed(apiUrl: string = (env.WHATSAPP_API_URL ?? '').trim()): boolean {
  if (apiUrl.trim() !== '') return false;
  return env.NODE_ENV !== 'production' || env.WHATSAPP_CLOUD_API_MOCK === 'true';
}
