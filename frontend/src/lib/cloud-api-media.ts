import { CLOUD_API_ACCEPTED_FORMATS } from '@crm-lab/shared';

/**
 * Aviso para a atendente quando a API oficial recusa o anexo (CRMLAB-140,
 * D-314 item 2). `null` = não é recusa da API oficial (segue o tratamento
 * comum). O motivo vem em `details.reason`; a tela nunca lê a `message`.
 */
export function cloudApiAttachmentMessage(
  fileName: string,
  details: Record<string, unknown> | undefined,
): string | null {
  const reason = details?.reason;
  if (reason === 'cloud_api_media_type') return `"${fileName}" não pode ser enviado: ${CLOUD_API_ACCEPTED_FORMATS}`;
  if (reason === 'cloud_api_image_limit') {
    return `"${fileName}" passa de 5 MB, o limite de foto da API oficial do WhatsApp.`;
  }
  return null;
}
