/**
 * Acesso a `tenant_channels` (SCHEMA.md §15) e `tenant_settings` (§16).
 *
 * ============================================================================
 * O SEGREDO NAO SAI DAQUI (D-064)
 * ============================================================================
 * `api_token` e `webhook_secret` sao write-only. A funcao de leitura da tela
 * (`listChannels`) projeta colunas EXPLICITAMENTE e ja devolve o token
 * mascarado e um booleano para o segredo do webhook — a linha crua nunca chega
 * ao service, e portanto nunca chega ao controller. `SELECT *` nesta tabela
 * devolvido ao controller e bug de seguranca, nao estilo (SCHEMA.md §15).
 *
 * A UNICA funcao que le os valores em claro e `findCredentials`, consumida so
 * pelo `resolveCredentials` do service (adapter do canal, D-024). Ela nao tem
 * caminho ate um controller.
 *
 * ============================================================================
 * TRES ESTADOS DE ESCRITA DE SEGREDO
 * ============================================================================
 * O `upsertChannel` recebe o patch com a distincao entre "chave ausente" e
 * "chave com `null`":
 *
 *   ausente -> a coluna NAO entra no SET (preserva o valor guardado)
 *   null    -> a coluna entra no SET com a SENTINELA DE REVOGACAO (apaga)
 *   string  -> a coluna entra no SET com o valor cifrado (grava)
 *
 * E por isso que o SET e montado dinamicamente a partir das chaves PRESENTES no
 * objeto, e nao a partir de `COALESCE($n, coluna)`: `COALESCE` trataria
 * "apagar" e "preservar" como a mesma coisa.
 *
 * ============================================================================
 * NULL x '' — "nunca configurou" x "REVOGOU" (D-073 emendada)
 * ============================================================================
 * As colunas de segredo tem TRES estados no banco, nao dois:
 *
 *   NULL -> o laboratorio NUNCA configurou este segredo. O resolver do canal
 *           cai na env var (fallback legitimo: dev, CI e o ambiente que ja
 *           rodava so com env var continuam funcionando).
 *   ''   -> o laboratorio APAGOU deliberadamente (`{"webhookSecret": null}` no
 *           PATCH). NAO ha fallback: revogar tem que revogar. Sem esta
 *           distincao, apagar o segredo do webhook devolveria o segredo GLOBAL
 *           da instalacao, e quem o conhecesse injetaria mensagem de paciente
 *           em qualquer tenant que nao tivesse girado o proprio.
 *   texto-> o valor (cifrado em repouso, D-076).
 *
 * A tela nao ve diferenca: `''` produz `apiTokenMasked: null` e
 * `webhookSecretSet: false`, exatamente como `NULL` (o contrato de §6 nao muda).
 *
 * ============================================================================
 * CIFRA EM REPOUSO (D-076)
 * ============================================================================
 * O que vai para `api_token`/`webhook_secret` passa por `encryptSecret`, e o
 * que sai passa por `decryptSecret`. Consequencia: a mascara do token NAO pode
 * mais sair do SQL (`RIGHT(api_token, 4)` sobre ciphertext seria mentira) — ela
 * e montada aqui, apos decifrar, e o valor em claro nao escapa desta funcao.
 * A fronteira de D-064 continua sendo o repositorio; so mudou de camada.
 */
import type { DbTx } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/secret-box.js';
import { toIso, toIsoOrNull, toJsonObject } from './row-mappers.js';

/** Sentinela de revogacao. Ver o bloco NULL x '' acima. */
export const REVOKED = '';

/** Formato ISO-UTC gerado pelo proprio banco (D-021: nunca `Date` do driver). */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Prefixo da mascara do token. 8 marcadores + os 4 ultimos caracteres. */
export const TOKEN_MASK_PREFIX = '••••••••';

// ---------------------------------------------------------------------------
// tenant_channels — leitura da tela (SEM segredo)
// ---------------------------------------------------------------------------

/** Projecao segura de `tenant_channels`: nenhum segredo em claro. */
export interface ChannelRow {
  id: string;
  channel: string;
  displayName: string | null;
  phoneNumberId: string | null;
  phoneNumber: string | null;
  isActive: boolean;
  apiTokenMasked: string | null;
  webhookSecretSet: boolean;
  connectedAt: string | null;
  updatedAt: string;
  /** `cloud_api` | `qr` (Onda 7, Bloco B — SCHEMA.md §15). */
  connectionMode: string;
  /** Aceite do termo de risco do QR. `null` = nunca aceito. */
  acceptedTermsAt: string | null;
}

/**
 * Mascara do token para a tela: `••••••••` + os 4 ultimos caracteres do valor
 * EM CLARO (API_CONTRACTS.md §6). O valor decifrado vive so dentro desta
 * funcao e nao e devolvido a ninguem.
 *
 * `null` (nunca configurado) e `''` (revogado) produzem a MESMA saida `null` —
 * "nao ha token configurado" e a unica coisa que a tela precisa saber.
 */
function maskToken(stored: string | null): string | null {
  const plain = decryptSecret(stored);
  if (plain === null || plain.length === 0) return null;
  return TOKEN_MASK_PREFIX + plain.slice(-4);
}

/**
 * Canais do laboratorio, ordem fixa por `channel ASC` (API_CONTRACTS.md §6).
 *
 * O booleano do segredo continua saindo do SQL (`<> ''` funciona sobre o
 * ciphertext). A mascara do token e montada em memoria: ver o bloco da cifra
 * no topo do arquivo.
 */
export async function listChannels(tx: DbTx, tenantId: string): Promise<ChannelRow[]> {
  const result = await tx.query<{
    id: string;
    channel: string;
    display_name: string | null;
    phone_number_id: string | null;
    phone_number: string | null;
    is_active: boolean;
    api_token: string | null;
    webhook_secret_set: boolean;
    connected_at: unknown;
    updated_at: unknown;
    connection_mode: string;
    accepted_terms_at: unknown;
  }>(
    `SELECT id,
            channel,
            display_name,
            phone_number_id,
            phone_number,
            is_active,
            api_token,
            (webhook_secret IS NOT NULL AND webhook_secret <> '') AS webhook_secret_set,
            to_char(connected_at, ${ISO_UTC}) AS connected_at,
            to_char(updated_at, ${ISO_UTC}) AS updated_at,
            connection_mode,
            to_char(accepted_terms_at, ${ISO_UTC}) AS accepted_terms_at
       FROM tenant_channels
      WHERE tenant_id = $1
      ORDER BY channel ASC`,
    [tenantId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    displayName: row.display_name,
    phoneNumberId: row.phone_number_id,
    phoneNumber: row.phone_number,
    isActive: row.is_active === true,
    apiTokenMasked: maskToken(row.api_token),
    webhookSecretSet: row.webhook_secret_set === true,
    connectedAt: toIsoOrNull(row.connected_at),
    updatedAt: toIso(row.updated_at),
    connectionMode: row.connection_mode,
    acceptedTermsAt: toIsoOrNull(row.accepted_terms_at),
  }));
}

// ---------------------------------------------------------------------------
// tenant_channels — escrita (upsert por `channel`)
// ---------------------------------------------------------------------------

/**
 * Patch de um canal. A DISTINCAO ausente/`null` e o contrato desta interface:
 * `apiToken?: string | null` com a chave ausente significa "preserva".
 */
export interface ChannelPatch {
  channel: string;
  displayName?: string | null;
  phoneNumberId?: string | null;
  phoneNumber?: string | null;
  isActive?: boolean;
  apiToken?: string | null;
  webhookSecret?: string | null;
}

/** Colunas opcionais do patch -> coluna do banco. `channel` fica de fora (e a chave). */
const PATCH_COLUMNS: ReadonlyArray<[keyof ChannelPatch, string]> = [
  ['displayName', 'display_name'],
  ['phoneNumberId', 'phone_number_id'],
  ['phoneNumber', 'phone_number'],
  ['isActive', 'is_active'],
  ['apiToken', 'api_token'],
  ['webhookSecret', 'webhook_secret'],
];

/** Chaves cujo valor e segredo: `null` vira sentinela de revogacao e string e cifrada. */
const SECRET_KEYS: ReadonlySet<keyof ChannelPatch> = new Set(['apiToken', 'webhookSecret']);

/**
 * Valor de uma chave do patch pronto para o parametro do SQL.
 *
 * Segredo com `null` NAO vira `NULL`: vira `''`. `NULL` continua significando
 * "nunca configurado" (e portanto "pode cair na env var"), e revogar nao pode
 * devolver o laboratorio para o segredo global da instalacao.
 */
function paramFor(key: keyof ChannelPatch, value: unknown): unknown {
  if (!SECRET_KEYS.has(key)) return value ?? null;
  if (value === null || value === undefined) return REVOKED;
  return typeof value === 'string' ? encryptSecret(value) : REVOKED;
}

/**
 * `INSERT ... ON CONFLICT (tenant_id, channel) DO UPDATE` (SERVICES.md §13).
 *
 * Canal ausente do array do PATCH nunca chega aqui — nao existe remocao nesta
 * rota; desligar e `isActive: false`.
 *
 * `connected_at` e do SERVIDOR: preenchido na PRIMEIRA gravacao de um
 * `apiToken` (string) e preservado depois — inclusive quando o token e apagado,
 * porque a data em que o canal foi conectado continua sendo um fato historico.
 */
export async function upsertChannel(
  tx: DbTx,
  tenantId: string,
  patch: ChannelPatch,
): Promise<void> {
  const insertColumns = ['tenant_id', 'channel'];
  const params: unknown[] = [tenantId, patch.channel];
  const values = ['$1', '$2'];
  const updates: string[] = [];

  for (const [key, column] of PATCH_COLUMNS) {
    if (!(key in patch)) continue;
    params.push(paramFor(key, patch[key]));
    const placeholder = `$${params.length}`;
    insertColumns.push(column);
    values.push(placeholder);
    updates.push(`${column} = ${placeholder}`);
  }

  // Conectar = gravar um token pela primeira vez.
  const connecting = typeof patch.apiToken === 'string';
  if (connecting) {
    insertColumns.push('connected_at');
    values.push('NOW()');
    updates.push('connected_at = COALESCE(tenant_channels.connected_at, NOW())');
  }

  // `updated_at` tem trigger no UPDATE; o `DO UPDATE` precisa de ao menos uma
  // atribuicao para ser SQL valido, e um PATCH so com `channel` e legitimo.
  if (updates.length === 0) {
    updates.push('updated_at = NOW()');
  }

  await tx.query(
    `INSERT INTO tenant_channels (${insertColumns.join(', ')})
          VALUES (${values.join(', ')})
     ON CONFLICT (tenant_id, channel)
     DO UPDATE SET ${updates.join(', ')}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// tenant_channels — credenciais em claro (UNICO ponto)
// ---------------------------------------------------------------------------

export interface ChannelCredentials {
  phoneNumberId: string | null;
  /** `null` = nunca configurado (pode cair na env var) · `''` = REVOGADO. */
  apiToken: string | null;
  /** `null` = nunca configurado (pode cair na env var) · `''` = REVOGADO. */
  webhookSecret: string | null;
  /**
   * `is_active` da linha (D-074). `false` desliga o canal nos DOIS sentidos:
   * o webhook para de ser aceito e o envio para de sair.
   */
  isActive: boolean;
  /** `cloud_api` | `qr` (Onda 7). Decide o driver de envio (D-024/D-032). */
  connectionMode: 'cloud_api' | 'qr';
}

/**
 * Valores EM CLARO do canal. Consumido apenas por
 * `ChannelSettingsService.resolveCredentials` (adapter do canal, D-024).
 * `null` quando o laboratorio nao tem LINHA para o canal — o resolver entao cai
 * nas env vars, que e o comportamento de hoje.
 */
export async function findCredentials(
  tx: DbTx,
  tenantId: string,
  channel: string,
): Promise<ChannelCredentials | null> {
  const result = await tx.query<{
    phone_number_id: string | null;
    api_token: string | null;
    webhook_secret: string | null;
    is_active: boolean;
    connection_mode: string;
  }>(
    `SELECT phone_number_id, api_token, webhook_secret, is_active, connection_mode
       FROM tenant_channels
      WHERE tenant_id = $1 AND channel = $2`,
    [tenantId, channel],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    phoneNumberId: row.phone_number_id,
    apiToken: decryptSecret(row.api_token),
    webhookSecret: decryptSecret(row.webhook_secret),
    isActive: row.is_active === true,
    connectionMode: row.connection_mode === 'qr' ? 'qr' : 'cloud_api',
  };
}

// ---------------------------------------------------------------------------
// tenant_channels — conexao WhatsApp por QR (Onda 7, Bloco B)
// ---------------------------------------------------------------------------

/**
 * Aceite do termo de risco do QR (dado do CANAL, nao so do audit log — a UI
 * precisa saber se ja foi aceito). Cria a linha se ainda nao existir: aceitar
 * o termo e SEMPRE o primeiro passo de `connectWhatsAppQr`, antes de qualquer
 * chamada ao gateway.
 */
export async function acceptWhatsAppQrTerms(
  tx: DbTx,
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO tenant_channels (tenant_id, channel, connection_mode, accepted_terms_at, accepted_terms_by)
          VALUES ($1, 'whatsapp', 'qr', NOW(), $2)
     ON CONFLICT (tenant_id, channel)
     DO UPDATE SET connection_mode = 'qr', accepted_terms_at = NOW(), accepted_terms_by = $2`,
    [tenantId, userId],
  );
}

/**
 * Estado de conexao do canal QR, para `getWhatsAppStatus`/`connectWhatsAppQr`.
 * Separado de `ChannelRow` (leitura da TELA) e de `ChannelCredentials`
 * (leitura do ADAPTER) porque nenhum dos dois carrega exatamente este recorte.
 */
export interface ConnectionState {
  connectionMode: 'cloud_api' | 'qr';
  connectedAt: string | null;
  phoneNumber: string | null;
  acceptedTermsAt: string | null;
}

export async function findConnectionState(
  tx: DbTx,
  tenantId: string,
  channel: string,
): Promise<ConnectionState | null> {
  const result = await tx.query<{
    connection_mode: string;
    phone_number: string | null;
    connected_at: unknown;
    accepted_terms_at: unknown;
  }>(
    `SELECT connection_mode, phone_number,
            to_char(connected_at, ${ISO_UTC}) AS connected_at,
            to_char(accepted_terms_at, ${ISO_UTC}) AS accepted_terms_at
       FROM tenant_channels
      WHERE tenant_id = $1 AND channel = $2`,
    [tenantId, channel],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    connectionMode: row.connection_mode === 'qr' ? 'qr' : 'cloud_api',
    phoneNumber: row.phone_number,
    connectedAt: toIsoOrNull(row.connected_at),
    acceptedTermsAt: toIsoOrNull(row.accepted_terms_at),
  };
}

/**
 * Canal pareado com sucesso (webhook `CONNECTION_UPDATE` com `state: 'open'`,
 * ou logo apos o QR ser escaneado). `phoneNumber` `null` preserva o valor
 * anterior — nem todo evento do gateway carrega o numero.
 */
export async function markWhatsAppConnected(
  tx: DbTx,
  tenantId: string,
  phoneNumber: string | null,
): Promise<void> {
  await tx.query(
    `UPDATE tenant_channels
        SET is_active = TRUE,
            connected_at = NOW(),
            phone_number = COALESCE($2, phone_number)
      WHERE tenant_id = $1 AND channel = 'whatsapp'`,
    [tenantId, phoneNumber],
  );
}

/**
 * Desconectado — pelo admin (`disconnectWhatsApp`) ou pelo gateway (`loggedOut`
 * no celular, banimento). `connected_at` volta a `NULL` de proposito: ao
 * contrario do canal `cloud_api` (onde a data e fato historico preservado, ver
 * `upsertChannel`), aqui ela alimenta o polling do frontend — precisa refletir
 * "desconectado agora", nao "conectou uma vez".
 */
export async function markWhatsAppDisconnected(tx: DbTx, tenantId: string): Promise<void> {
  await tx.query(
    `UPDATE tenant_channels
        SET is_active = FALSE,
            connected_at = NULL
      WHERE tenant_id = $1 AND channel = 'whatsapp'`,
    [tenantId],
  );
}

// ---------------------------------------------------------------------------
// tenant_settings
// ---------------------------------------------------------------------------

export interface SettingsRow {
  distributionMode: string;
  greetingEnabled: boolean;
  greetingMessage: string | null;
  offhoursEnabled: boolean;
  offhoursMessage: string | null;
  businessHours: Record<string, unknown> | null;
}

/**
 * `null` quando o laboratorio nunca gravou configuracao (D-065). O service
 * responde os DEFAULTS nesse caso — esta funcao nao grava nada, e o `GET`
 * inteiro e somente leitura.
 */
export async function findSettings(tx: DbTx, tenantId: string): Promise<SettingsRow | null> {
  const result = await tx.query<{
    distribution_mode: string;
    greeting_enabled: boolean;
    greeting_message: string | null;
    offhours_enabled: boolean;
    offhours_message: string | null;
    business_hours: unknown;
  }>(
    `SELECT distribution_mode, greeting_enabled, greeting_message,
            offhours_enabled, offhours_message, business_hours
       FROM tenant_settings
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    distributionMode: row.distribution_mode,
    greetingEnabled: row.greeting_enabled === true,
    greetingMessage: row.greeting_message,
    offhoursEnabled: row.offhours_enabled === true,
    offhoursMessage: row.offhours_message,
    businessHours: toJsonObject(row.business_hours),
  };
}

/** Estado COMPLETO de `tenant_settings` — o service ja fez o merge parcial. */
export interface SettingsWrite {
  distributionMode: string;
  greetingEnabled: boolean;
  greetingMessage: string | null;
  offhoursEnabled: boolean;
  offhoursMessage: string | null;
  businessHours: unknown;
}

/** Cria a linha na PRIMEIRA escrita; depois atualiza (D-065). */
export async function upsertSettings(
  tx: DbTx,
  tenantId: string,
  settings: SettingsWrite,
): Promise<void> {
  await tx.query(
    `INSERT INTO tenant_settings (tenant_id, distribution_mode, greeting_enabled,
                                  greeting_message, offhours_enabled, offhours_message,
                                  business_hours)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant_id)
     DO UPDATE SET distribution_mode = $2,
                   greeting_enabled  = $3,
                   greeting_message  = $4,
                   offhours_enabled  = $5,
                   offhours_message  = $6,
                   business_hours    = $7::jsonb`,
    [
      tenantId,
      settings.distributionMode,
      settings.greetingEnabled,
      settings.greetingMessage,
      settings.offhoursEnabled,
      settings.offhoursMessage,
      JSON.stringify(settings.businessHours),
    ],
  );
}

// ---------------------------------------------------------------------------
// users — recorte minimo da equipe (D-066)
// ---------------------------------------------------------------------------

export interface TeamRow {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

/**
 * Equipe do laboratorio: papeis de laboratorio, ATIVOS E INATIVOS, `name ASC`.
 *
 * A projecao e deliberadamente de quatro colunas (D-066): sem e-mail e sem
 * alcada. Qualquer campo alem destes passa a exigir `GET /users`, que e admin —
 * e esta tela e lida pelo gestor.
 */
export async function listTeam(tx: DbTx, tenantId: string): Promise<TeamRow[]> {
  const result = await tx.query<{
    id: string;
    name: string;
    role: string;
    is_active: boolean;
  }>(
    `SELECT id, name, role, is_active
       FROM users
      WHERE tenant_id = $1
        AND role IN ('attendant', 'manager', 'admin')
      ORDER BY name ASC, id ASC`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active === true,
  }));
}
