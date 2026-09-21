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
