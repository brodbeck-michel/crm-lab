/**
 * ChannelSettingsService — SERVICES.md §13, API_CONTRACTS.md §6.
 *
 * ============================================================================
 * O SEGREDO NUNCA SAI PELA API (D-064)
 * ============================================================================
 * `apiToken` e `webhookSecret` sao write-only. A leitura da tela vem de
 * `channelSettingsRepo.listChannels`, que projeta colunas explicitamente e ja
 * devolve `apiTokenMasked` e `webhookSecretSet` — o valor em claro nao chega a
 * este arquivo no caminho do `GET`/`PATCH`. O unico metodo que le o valor em
 * claro e `resolveCredentials`, consumido pelo adapter do canal (D-024), e o
 * retorno dele nao passa por controller nenhum.
 *
 * O audit log tambem nao ve o segredo: `redactSecrets` troca qualquer
 * `apiToken`/`webhookSecret` por `"[REDACTED]"` antes de gravar.
 *
 * ============================================================================
 * TRES ESTADOS DE ESCRITA DE SEGREDO
 * ============================================================================
 *   ausente -> preserva o valor guardado
 *   null    -> apaga
 *   string  -> grava
 *
 * A distincao "ausente" x "`null`" e o motivo de a validacao trabalhar sobre o
 * objeto CRU (`'apiToken' in channel`) e de o repositorio montar o `SET`
 * dinamicamente. Um `COALESCE($n, coluna)` no SQL colapsaria "apagar" e
 * "preservar" no mesmo caminho, e apagar um token vazado passaria a ser
 * impossivel pela tela.
 *
 * ============================================================================
 * LINHA AUSENTE = DEFAULTS (D-065)
 * ============================================================================
 * `get` responde `manual`, mensagens desligadas e `America/Sao_Paulo` quando
 * nao ha linha em `tenant_settings`, SEM gravar. O `GET` e somente leitura: o
 * primeiro `PATCH` e que faz o `INSERT ... ON CONFLICT`.
 */
import type {
  AutoMessage,
  AutoMessagesSettings,
  BusinessHours,
  BusinessHoursRange,
  ChannelSettingsResponse,
  ChannelTeamMember,
  ConversationChannel,
  DistributionMode,
  TenantChannel,
  UpdateChannelSettingsRequest,
  UpdateTenantChannelInput,
  UserRole,
  WeekDay,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import * as channelSettingsRepo from '../repositories/channel-settings.repository.js';
import type { AuditService } from './audit.service.js';

/** Os quatro canais do contrato (`ConversationChannel`). */
const CHANNELS: readonly ConversationChannel[] = ['whatsapp', 'sms', 'web', 'direct'];

const DISTRIBUTION_MODES: readonly DistributionMode[] = ['manual', 'round_robin'];

const WEEK_DAYS: readonly WeekDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const TEAM_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'];

/** Fuso padrao quando o laboratorio nunca configurou (D-065). */
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

export const LIMITS = {
  displayName: 255,
  phoneNumberId: 255,
  phoneNumber: 30,
  apiTokenMin: 10,
  apiTokenMax: 500,
  webhookSecretMin: 16,
  webhookSecretMax: 255,
  messageMax: 1000,
} as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Marcador gravado no audit log no lugar de qualquer segredo (D-064). */
export const REDACTED = '[REDACTED]';

export interface ChannelSettingsService {
  /** manager/admin. NUNCA devolve segredo em claro. */
  get(ctx: TenantContext): Promise<ChannelSettingsResponse>;
  /** admin. Upsert de canais por `channel` + patch parcial das configuracoes. */
  update(
    ctx: TenantContext,
    dto: UpdateChannelSettingsRequest,
  ): Promise<ChannelSettingsResponse>;
  /** Le os valores EM CLARO. So o adapter do canal chama (D-024). */
  resolveCredentials(
    tenantId: string,
    channel: ConversationChannel,
  ): Promise<channelSettingsRepo.ChannelCredentials | null>;
}

export interface ChannelSettingsServiceDeps {
  db: DbClient;
  audit: AuditService;
}

// ---------------------------------------------------------------------------
// Defaults (D-065)
// ---------------------------------------------------------------------------

function defaultAutoMessage(): AutoMessage {
  return { enabled: false, message: null };
}

export function defaultAutoMessages(): AutoMessagesSettings {
  return { greeting: defaultAutoMessage(), offHours: defaultAutoMessage() };
}

export function defaultBusinessHours(): BusinessHours {
  return { timezone: DEFAULT_TIMEZONE, days: {} };
}

/** Estado que o `GET` responde quando nao ha linha em `tenant_settings`. */
export function defaultSettings(): {
  distributionMode: DistributionMode;
  autoMessages: AutoMessagesSettings;
  businessHours: BusinessHours;
} {
  return {
    distributionMode: 'manual',
    autoMessages: defaultAutoMessages(),
    businessHours: defaultBusinessHours(),
  };
}

// ---------------------------------------------------------------------------
// Permissao — "a UI esconde, o servidor recusa"
// ---------------------------------------------------------------------------

function assertReadRole(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...TEAM_ROLES] });
  }
  if (ctx.role !== 'manager' && ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['manager', 'admin'] });
  }
}

function assertWriteRole(ctx: TenantContext): void {
  if (ctx.role === 'platform_operator') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: [...TEAM_ROLES] });
  }
  if (ctx.role !== 'admin') {
    throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
  }
}

// ---------------------------------------------------------------------------
// Validacao — no service, para valer tambem sem middleware
// ---------------------------------------------------------------------------

/** Acumulador de `details.fields` (formato de API_ERRORS.md). */
class FieldErrors {
  private readonly fields: Record<string, string> = {};

  add(path: string, message: string): void {
    if (!(path in this.fields)) this.fields[path] = message;
  }

  get empty(): boolean {
    return Object.keys(this.fields).length === 0;
  }

  throwIfAny(): void {
    if (!this.empty) throw new BusinessError('VALIDATION_ERROR', { fields: { ...this.fields } });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Texto opcional e anulavel (`displayName`, `phoneNumberId`, `phoneNumber`).
 * Chave ausente -> `undefined` (preserva). `null` -> apaga. String vazia e
 * recusada: apagar e `null`, explicitamente.
 */
function checkNullableText(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  errors: FieldErrors,
): void {
  if (!(key in raw)) return;
  const value = raw[key];
  if (value === null) return;
  if (typeof value !== 'string') {
    errors.add(path, 'Valor deve ser texto ou null');
    return;
  }
  if (value.length === 0) errors.add(path, 'Use null para apagar; texto vazio nao e aceito');
  else if (value.length > max) errors.add(path, `Maximo de ${max} caracteres`);
}

/** Segredo: ausente preserva · `null` apaga · string grava. `""` e erro. */
function checkSecret(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  errors: FieldErrors,
): void {
  if (!(key in raw)) return;
  const value = raw[key];
  if (value === null) return;
  if (typeof value !== 'string') {
    errors.add(path, 'Valor deve ser texto ou null');
    return;
  }
  if (value.length < min || value.length > max) {
    errors.add(path, `Deve ter entre ${min} e ${max} caracteres (use null para apagar)`);
  }
}

/**
 * Caminho de `details.fields` para um campo de canal (API_ERRORS.md).
 *
 * A chave e o NOME DO CANAL (`channels.whatsapp.apiToken`), nunca o indice do
 * array (`channels.0.apiToken`). O array do PATCH e esparso e sem ordem
 * garantida — a tela monta so os canais SUJOS —, entao o indice do corpo nao
 * corresponde a nenhum campo da tela: um `phoneNumber` longo demais devolvia
 * 400 com uma chave que a tela nao encontrava, ela apagava a mensagem geral e
 * o admin nao via erro nenhum. O nome do canal e a mesma chave dos dois lados.
 */
export function channelFieldPath(channel: string, field?: string): string {
  return field === undefined ? `channels.${channel}` : `channels.${channel}.${field}`;
}

function validateChannels(raw: unknown, errors: FieldErrors): channelSettingsRepo.ChannelPatch[] {
  if (!Array.isArray(raw)) {
    errors.add('channels', 'channels deve ser uma lista');
    return [];
  }

  const seen = new Set<string>();
  const patches: channelSettingsRepo.ChannelPatch[] = [];

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      // Sem `channel` legivel nao ha nome para usar: o indice e o unico
      // identificador possivel, e a tela cai na mensagem geral.
      errors.add(`channels.${index}`, 'Cada canal deve ser um objeto');
      return;
    }
    const channel = entry.channel;
    if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
      errors.add(`channels.${index}.channel`, `channel deve ser um de: ${CHANNELS.join(', ')}`);
      return;
    }
    const base = channelFieldPath(channel);
    if (seen.has(channel)) {
      errors.add(`${base}.channel`, 'Canal repetido no mesmo array');
      return;
    }
    seen.add(channel);

    checkNullableText(entry, 'displayName', `${base}.displayName`, LIMITS.displayName, errors);
    checkNullableText(
      entry,
      'phoneNumberId',
      `${base}.phoneNumberId`,
      LIMITS.phoneNumberId,
      errors,
    );
    checkNullableText(entry, 'phoneNumber', `${base}.phoneNumber`, LIMITS.phoneNumber, errors);
    if ('isActive' in entry && typeof entry.isActive !== 'boolean') {
      errors.add(`${base}.isActive`, 'isActive deve ser booleano');
    }
    checkSecret(
      entry,
      'apiToken',
      `${base}.apiToken`,
      LIMITS.apiTokenMin,
      LIMITS.apiTokenMax,
      errors,
    );
    checkSecret(
      entry,
      'webhookSecret',
      `${base}.webhookSecret`,
      LIMITS.webhookSecretMin,
      LIMITS.webhookSecretMax,
      errors,
    );

    // O patch preserva a distincao ausente x null: so copiamos as chaves
    // PRESENTES no corpo. O repositorio monta o SET a partir delas.
    const patch: channelSettingsRepo.ChannelPatch = { channel };
    for (const key of [
      'displayName',
      'phoneNumberId',
      'phoneNumber',
      'isActive',
      'apiToken',
      'webhookSecret',
    ] as const) {
      if (key in entry) {
        Object.assign(patch, { [key]: entry[key] });
      }
    }
    patches.push(patch);
  });

  return patches;
}

/**
 * PATCH parcial por mensagem: enviar so `greeting` preserva `offHours`.
 * `enabled: true` com texto nulo/vazio e VALIDATION_ERROR — mensagem automatica
 * ligada e vazia enviaria uma bolha em branco ao paciente.
 */
function mergeAutoMessage(
  current: AutoMessage,
  raw: unknown,
  path: string,
  errors: FieldErrors,
): AutoMessage {
  if (raw === undefined) return current;
  if (!isRecord(raw)) {
    errors.add(path, 'Mensagem automatica deve ser um objeto');
    return current;
  }

  let enabled = current.enabled;
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') {
      errors.add(`${path}.enabled`, 'enabled deve ser booleano');
    } else {
      enabled = raw.enabled;
    }
  }

  let message = current.message;
  if ('message' in raw) {
    const value = raw.message;
    if (value === null) {
      message = null;
    } else if (typeof value !== 'string') {
      errors.add(`${path}.message`, 'message deve ser texto ou null');
    } else if (value.length > LIMITS.messageMax) {
      errors.add(`${path}.message`, `Maximo de ${LIMITS.messageMax} caracteres`);
    } else {
      message = value;
    }
  }

  if (enabled && (message === null || message.trim().length === 0)) {
    errors.add(`${path}.message`, 'Mensagem automatica ligada exige texto');
  }

  return { enabled, message };
}

function validateAutoMessages(
  current: AutoMessagesSettings,
  raw: unknown,
  errors: FieldErrors,
): AutoMessagesSettings {
  if (!isRecord(raw)) {
    errors.add('autoMessages', 'autoMessages deve ser um objeto');
    return current;
  }
  return {
    greeting: mergeAutoMessage(current.greeting, raw.greeting, 'autoMessages.greeting', errors),
    offHours: mergeAutoMessage(current.offHours, raw.offHours, 'autoMessages.offHours', errors),
  };
}

/**
 * `businessHours` e SUBSTITUICAO, nao merge (D-065): o objeto enviado vira o
 * novo horario inteiro, e dia omitido = fechado. Merge por dia tornaria
 * impossivel fechar um dia sem inventar um sentinela.
 */
function validateBusinessHours(raw: unknown, errors: FieldErrors): BusinessHours {
  const fallback = defaultBusinessHours();
  if (!isRecord(raw)) {
    errors.add('businessHours', 'businessHours deve ser um objeto');
    return fallback;
  }

  let timezone = DEFAULT_TIMEZONE;
  if (typeof raw.timezone !== 'string' || !isIanaTimezone(raw.timezone)) {
    errors.add('businessHours.timezone', 'timezone deve ser um fuso IANA valido');
  } else {
    timezone = raw.timezone;
  }

  const days: Partial<Record<WeekDay, BusinessHoursRange | null>> = {};
  const rawDays = raw.days;
  if (rawDays !== undefined && !isRecord(rawDays)) {
    errors.add('businessHours.days', 'days deve ser um objeto');
    return { timezone, days };
  }

  for (const [key, value] of Object.entries(rawDays ?? {})) {
    const path = `businessHours.days.${key}`;
    if (!(WEEK_DAYS as readonly string[]).includes(key)) {
      errors.add(path, `Dia invalido: use ${WEEK_DAYS.join(', ')}`);
      continue;
    }
    const day = key as WeekDay;
    if (value === null) {
      days[day] = null;
      continue;
    }
    if (!isRecord(value)) {
      errors.add(path, 'Faixa deve ser um objeto { start, end } ou null');
      continue;
    }
    const start = value.start;
    const end = value.end;
    if (typeof start !== 'string' || !TIME_PATTERN.test(start)) {
      errors.add(`${path}.start`, 'Horario deve estar no formato HH:MM (24h)');
      continue;
    }
    if (typeof end !== 'string' || !TIME_PATTERN.test(end)) {
      errors.add(`${path}.end`, 'Horario deve estar no formato HH:MM (24h)');
      continue;
    }
    if (start >= end) {
      errors.add(`${path}.end`, 'end deve ser maior que start');
      continue;
    }
    days[day] = { start, end };
  }

  return { timezone, days };
}

// ---------------------------------------------------------------------------
// Auditoria — segredo redigido (D-064)
// ---------------------------------------------------------------------------

/**
 * Copia do corpo com `apiToken`/`webhookSecret` trocados por `"[REDACTED]"`.
 * O `null` tambem vira `[REDACTED]`? Nao: apagar nao e segredo, e a informacao
 * util no log e justamente "o token foi removido". So o VALOR e escondido.
 */
export function redactSecrets(dto: UpdateChannelSettingsRequest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...dto };
  if (Array.isArray(dto.channels)) {
    copy.channels = dto.channels.map((channel: UpdateTenantChannelInput) => {
      const entry: Record<string, unknown> = { ...channel };
      if ('apiToken' in entry) {
        entry.apiToken = entry.apiToken === null ? null : REDACTED;
      }
      if ('webhookSecret' in entry) {
        entry.webhookSecret = entry.webhookSecret === null ? null : REDACTED;
      }
      return entry;
    });
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Montagem da resposta
// ---------------------------------------------------------------------------

function toChannel(value: string): ConversationChannel {
  return (CHANNELS as readonly string[]).includes(value)
    ? (value as ConversationChannel)
    : 'direct';
}

function toRole(value: string): UserRole {
  return (TEAM_ROLES as readonly string[]).includes(value) ? (value as UserRole) : 'attendant';
}

function toDistributionMode(value: string): DistributionMode {
  return (DISTRIBUTION_MODES as readonly string[]).includes(value)
    ? (value as DistributionMode)
    : 'manual';
}

function toTenantChannel(row: channelSettingsRepo.ChannelRow): TenantChannel {
  return {
    id: row.id,
    channel: toChannel(row.channel),
    displayName: row.displayName,
    phoneNumberId: row.phoneNumberId,
    phoneNumber: row.phoneNumber,
    isActive: row.isActive,
    apiTokenMasked: row.apiTokenMasked,
    webhookSecretSet: row.webhookSecretSet,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}

function toTeamMember(row: channelSettingsRepo.TeamRow): ChannelTeamMember {
  return { id: row.id, name: row.name, role: toRole(row.role), isActive: row.isActive };
}

/** `SettingsRow | null` -> os tres blocos de configuracao (null = defaults). */
function toSettings(row: channelSettingsRepo.SettingsRow | null): {
  distributionMode: DistributionMode;
  autoMessages: AutoMessagesSettings;
  businessHours: BusinessHours;
} {
  if (row === null) return defaultSettings();
  const stored = row.businessHours;
  const businessHours =
    stored === null
      ? defaultBusinessHours()
      : {
          timezone:
            typeof stored.timezone === 'string' ? stored.timezone : DEFAULT_TIMEZONE,
          days: isRecord(stored.days)
            ? (stored.days as BusinessHours['days'])
            : ({} as BusinessHours['days']),
        };

  return {
    distributionMode: toDistributionMode(row.distributionMode),
    autoMessages: {
      greeting: { enabled: row.greetingEnabled, message: row.greetingMessage },
      offHours: { enabled: row.offhoursEnabled, message: row.offhoursMessage },
    },
    businessHours,
  };
}

/** Leitura completa da tela dentro de uma transacao ja aberta. */
async function readAll(tx: DbTx, tenantId: string): Promise<ChannelSettingsResponse> {
  const channels = await channelSettingsRepo.listChannels(tx, tenantId);
  const settings = await channelSettingsRepo.findSettings(tx, tenantId);
  const team = await channelSettingsRepo.listTeam(tx, tenantId);
  const resolved = toSettings(settings);
  return {
    channels: channels.map(toTenantChannel),
    distributionMode: resolved.distributionMode,
    autoMessages: resolved.autoMessages,
    businessHours: resolved.businessHours,
    team: team.map(toTeamMember),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createChannelSettingsService(
  deps: ChannelSettingsServiceDeps,
): ChannelSettingsService {
  const { db, audit } = deps;

  const get = async (ctx: TenantContext): Promise<ChannelSettingsResponse> => {
    assertReadRole(ctx);
    // Somente leitura: nenhuma linha de `tenant_settings` nasce aqui (D-065).
    return db.withTenant(ctx.tenantId, (tx) => readAll(tx, ctx.tenantId));
  };

  const update = async (
    ctx: TenantContext,
    dto: UpdateChannelSettingsRequest,
  ): Promise<ChannelSettingsResponse> => {
    assertWriteRole(ctx);

    const raw: unknown = dto;
    if (!isRecord(raw)) {
      throw new BusinessError('VALIDATION_ERROR', { fields: { _root: 'Corpo invalido' } });
    }

    const known = ['channels', 'distributionMode', 'autoMessages', 'businessHours'] as const;
    const errors = new FieldErrors();

    // Schema `strict` (API_CONTRACTS.md §6): chave desconhecida e erro, nao
    // ruido ignorado — um `distributionMod` com typo salvaria nada e a tela
    // acharia que salvou.
    for (const key of Object.keys(raw)) {
      if (!(known as readonly string[]).includes(key)) {
        errors.add(key, 'Campo desconhecido');
      }
    }
    if (known.every((key) => !(key in raw))) {
      errors.add('_root', 'Envie ao menos um campo para atualizar');
    }

    let distributionMode: DistributionMode | undefined;
    if ('distributionMode' in raw) {
      const value = raw.distributionMode;
      if (
        typeof value !== 'string' ||
        !(DISTRIBUTION_MODES as readonly string[]).includes(value)
      ) {
        errors.add('distributionMode', `Deve ser um de: ${DISTRIBUTION_MODES.join(', ')}`);
      } else {
        distributionMode = value as DistributionMode;
      }
    }

    const channelPatches = 'channels' in raw ? validateChannels(raw.channels, errors) : [];
    errors.throwIfAny();

    const saved = await db.withTenant(ctx.tenantId, async (tx) => {
      const previous = await readAll(tx, ctx.tenantId);

      for (const patch of channelPatches) {
        await channelSettingsRepo.upsertChannel(tx, ctx.tenantId, patch);
      }

      const touchesSettings =
        distributionMode !== undefined || 'autoMessages' in raw || 'businessHours' in raw;

      if (touchesSettings) {
        const autoMessages =
          'autoMessages' in raw
            ? validateAutoMessages(previous.autoMessages, raw.autoMessages, errors)
            : previous.autoMessages;
        const businessHours =
          'businessHours' in raw
            ? validateBusinessHours(raw.businessHours, errors)
            : previous.businessHours;
        errors.throwIfAny();

        await channelSettingsRepo.upsertSettings(tx, ctx.tenantId, {
          distributionMode: distributionMode ?? previous.distributionMode,
          greetingEnabled: autoMessages.greeting.enabled,
          greetingMessage: autoMessages.greeting.message,
          offhoursEnabled: autoMessages.offHours.enabled,
          offhoursMessage: autoMessages.offHours.message,
          businessHours,
        });
      }

      return { previous, current: await readAll(tx, ctx.tenantId) };
    });

    await audit.record(ctx, {
      action: 'update_channel_settings',
      entityType: 'tenant_settings',
      entityId: ctx.tenantId,
      // `previous`/`current` ja vem mascarados do repositorio; `newValues`
      // carrega o pedido com os segredos redigidos, para o log dizer O QUE se
      // tentou mudar sem carregar o valor.
      oldValues: {
        channels: saved.previous.channels,
        distributionMode: saved.previous.distributionMode,
        autoMessages: saved.previous.autoMessages,
        businessHours: saved.previous.businessHours,
      },
      newValues: {
        requested: redactSecrets(dto),
        channels: saved.current.channels,
        distributionMode: saved.current.distributionMode,
        autoMessages: saved.current.autoMessages,
        businessHours: saved.current.businessHours,
      },
    });

    return saved.current;
  };

  const resolveCredentials = async (
    tenantId: string,
    channel: ConversationChannel,
  ): Promise<channelSettingsRepo.ChannelCredentials | null> =>
    db.withTenant(tenantId, (tx) => channelSettingsRepo.findCredentials(tx, tenantId, channel));

  return { get, update, resolveCredentials };
}
