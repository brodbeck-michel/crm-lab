/**
 * So a mídia servida pelo NOSSO backend (`/api/v1/media/:id`) exige o fetch
 * autenticado. Um `attachmentUrl` ABSOLUTO de outro host (a URL da Meta que o
 * webhook grava, ou o que vier num `POST /messages`) tem que ir como link/img
 * cru: passar pelo `fetchAuthenticatedBlob` mandava o Bearer do usuário para
 * um terceiro e o CORS ainda bloqueava a resposta — o anexo que antes abria
 * virou "Não foi possível carregar" (revisão do PR #43).
 *
 * Em arquivo próprio desde o CRMLAB-70: os componentes por tipo (vídeo,
 * documento, figurinha) usam a mesma regra sem importar o `MessageBubble`.
 */
export function isProtectedMediaUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return url.startsWith('/api/');
  try {
    const target = new URL(url);
    return target.origin === window.location.origin && target.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}
