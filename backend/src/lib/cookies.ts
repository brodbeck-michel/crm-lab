/**
 * Nome e path do cookie de refresh (D-142/D-151) — fonte unica para quem
 * grava (`controllers/auth.routes.ts`) e quem le fora do pipeline do Express
 * (`ws-hub.ts`: o upgrade de WebSocket nunca passa por `cookie-parser`).
 */
export const REFRESH_COOKIE_NAME = 'crm_refresh';

/**
 * `/` desde D-151 (era `/api/v1/auth`, D-142): o handshake do WebSocket em
 * `/ws` tambem precisa do cookie, e um cookie so aceita um `Path`. `HttpOnly`
 * + `SameSite=Strict` continuam sendo a defesa real contra roubo/CSRF do
 * refresh; `Path` estreito so reduzia a superficie de quais rotas o
 * recebiam automaticamente. Para o WS especificamente, quem cobre o risco de
 * CSRF (que `Path` nao cobriria de qualquer forma — WebSocket ignora a
 * Same-Origin Policy do jeito que `fetch` respeita) e a checagem do header
 * `Origin` no upgrade, em `ws-hub.ts`.
 */
export const REFRESH_COOKIE_PATH = '/';

/**
 * Path que o cookie tinha na D-142 (Onda B, ja em producao desde a v1.12.0).
 *
 * Um cookie e identificado por (nome, dominio, PATH): gravar `crm_refresh` em
 * `/` NAO substitui o `crm_refresh` que o browser ja guarda em `/api/v1/auth`
 * — o usuario fica com OS DOIS. Em `POST /api/v1/auth/refresh` os dois sao
 * enviados, o de path mais especifico vem primeiro (RFC 6265 §5.4) e o
 * `cookie-parser` fica com a PRIMEIRA ocorrencia: ou seja, a rota leria
 * eternamente o token VELHO. Na primeira renovacao depois do deploy esse
 * token velho e consumido e rotacionado; na segunda ele e reapresentado ja
 * revogado, o que dispara a deteccao de reuso (D-015) e derruba a familia
 * inteira — logout forcado de todas as sessoes de todo mundo que estava
 * logado no momento do deploy, em loop, ate o cookie velho expirar (7 dias).
 *
 * Por isso toda resposta que grava ou limpa o cookie manda TAMBEM um
 * `Set-Cookie` de expiracao neste path. Pode sair depois que ninguem mais
 * tiver sessao aberta de antes da v1.13.0 — ou seja, `JWT_REFRESH_TTL` (7
 * dias) depois do deploy desta onda.
 */
export const LEGACY_REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Extrai um cookie do header `Cookie` cru.
 *
 * O upgrade de WebSocket (`server.on('upgrade', ...)`) e um evento HTTP que
 * NUNCA passa pelos middlewares do Express (`cookie-parser` incluido) — soh
 * chega o `IncomingMessage` bruto. Parser minimo de proposito: so precisamos
 * extrair UM valor, nao adicionar mais uma dependencia pra isso.
 */
export function getCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
