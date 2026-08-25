/**
 * Cifra de credencial de canal EM REPOUSO (D-076).
 *
 * ============================================================================
 * Por que existe
 * ============================================================================
 * `tenant_channels.api_token` e `tenant_channels.webhook_secret` sao segredos
 * que precisam VOLTAR em claro (o token vai no `Authorization` do canal, o
 * segredo assina o HMAC do webhook), entao hash — o precedente de
 * `refresh_tokens` (SCHEMA.md §14) — nao serve. Sem cifra, um dump de backup
 * entrega token e segredo de HMAC de TODOS os laboratorios da instalacao, e o
 * segredo do HMAC e escrita: quem o tem injeta mensagem de paciente.
 *
 * AES-256-GCM (autenticado: adulterar o ciphertext falha na verificacao da tag,
 * nao devolve lixo). A chave vem de `CHANNEL_SECRET_KEY` e NAO mora no banco —
 * e isso que faz o dump sozinho nao bastar.
 *
 * ============================================================================
 * Dois valores que NUNCA sao cifrados, de proposito
 * ============================================================================
 * - `''` (string vazia) e a SENTINELA DE REVOGACAO (D-073 emendada): "o
 *   laboratorio apagou este segredo deliberadamente". Nao e segredo, e estado,
 *   e o SQL de leitura da tela precisa compara-la (`<> ''`).
 * - `null` e "nunca configurado".
 *
 * ============================================================================
 * Sem chave configurada
 * ============================================================================
 * Em dev/CI a chave e opcional: o valor e gravado em claro e lido em claro
 * (mesmo comportamento de antes desta onda), para o repo continuar subindo sem
 * `.env`. Em `NODE_ENV=production` a chave e OBRIGATORIA — `env.ts` recusa o
 * boot sem ela. `decryptSecret` aceita valor em claro (linha antiga, seed) e
 * valor cifrado: a migracao de dado existente e preguicosa, na proxima escrita.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/** Prefixo + versao. Uma troca de algoritmo vira `enc:v2:` e convive com este. */
const PREFIX = 'enc:v1:';

const IV_BYTES = 12;

/**
 * Chave de 32 bytes derivada da env var. `sha256` da string aceita qualquer
 * formato/comprimento de chave configurada sem exigir base64 exato de 32 bytes
 * — o requisito de entropia e cobrado por `env.ts` (minimo de 32 caracteres).
 */
function key(): Buffer | null {
  // `process.env` primeiro (o `dotenv` de `env.ts` ja o preencheu, entao os dois
  // concordam): a chave e lida NO MOMENTO DA CHAMADA, e nao congelada no import.
  // E o que permite ao teste exercitar o caminho cifrado e o caminho em claro no
  // mesmo processo — sem isso, a cifra so seria testavel em producao.
  const raw = process.env.CHANNEL_SECRET_KEY ?? env.CHANNEL_SECRET_KEY;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** `true` quando o valor guardado esta cifrado por esta funcao. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Valor pronto para a coluna. Sem chave => texto em claro (dev/CI). */
export function encryptSecret(plain: string): string {
  // `''` e sentinela de revogacao, nao segredo: cifra-la esconderia o estado.
  if (plain.length === 0) return plain;
  const secretKey = key();
  if (!secretKey) return plain;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX + iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Valor da coluna -> valor em claro. `null` continua `null`; valor sem o
 * prefixo volta como esta (linha gravada antes de D-076, ou ambiente sem
 * chave). Ciphertext com a chave errada/ausente LANCA: devolver lixo faria o
 * webhook recusar tudo sem ninguem entender por que.
 */
export function decryptSecret(stored: string | null): string | null {
  if (stored === null || !isEncrypted(stored)) return stored;

  const secretKey = key();
  if (!secretKey) {
    throw new Error('CHANNEL_SECRET_KEY ausente: credencial de canal cifrada nao pode ser lida');
  }

  const [ivPart, tagPart, dataPart] = stored.slice(PREFIX.length).split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Credencial de canal cifrada com formato invalido');
  }

  const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
