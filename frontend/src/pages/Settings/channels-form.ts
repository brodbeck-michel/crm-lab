import type {
  AutoMessagesSettings,
  BusinessHoursRange,
  ChannelSettingsResponse,
  ConversationChannel,
  DistributionMode,
  TenantChannel,
  UpdateChannelSettingsRequest,
  UpdateTenantChannelInput,
  WeekDay,
} from '@crm-lab/shared';

/**
 * Estado de formulário da tela `/settings/channels` e a tradução dele para o
 * corpo do `PATCH` (docs/api/API_CONTRACTS.md §6).
 *
 * Está fora do componente de propósito: a REGRA DO SEGREDO — ausente preserva,
 * `null` apaga, string grava — é a parte desta tela em que um engano apaga o
 * token de produção do laboratório, e regra assim se testa como função pura,
 * não clicando na tela.
 */

export const WEEK_DAYS: readonly WeekDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEK_DAY_LABEL: Record<WeekDay, string> = {
  mon: 'Segunda',
  tue: 'Terça',
  wed: 'Quarta',
  thu: 'Quinta',
  fri: 'Sexta',
  sat: 'Sábado',
  sun: 'Domingo',
};

export const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  web: 'Web',
  direct: 'Direto',
};

export const DISTRIBUTION_LABEL: Record<DistributionMode, string> = {
  manual: 'Manual',
  round_robin: 'Rodízio (round-robin)',
};

export const DISTRIBUTION_HINT: Record<DistributionMode, string> = {
  manual: 'A conversa nova fica em "Não atribuídas" até alguém assumir.',
  round_robin: 'A conversa nova é distribuída automaticamente entre os atendentes ativos.',
};

/** Um canal em edição. Os campos `*Input`/`remove*` só existem no cliente. */
export interface ChannelDraft {
  channel: ConversationChannel;
  displayName: string;
  phoneNumberId: string;
  phoneNumber: string;
  isActive: boolean;
  /** Vem do servidor; nunca é editável. */
  apiTokenMasked: string | null;
  /** Vem do servidor; nunca é editável. */
  webhookSecretSet: boolean;
  /** Campo de escrita. Vazio = NÃO vai no corpo (preserva o segredo atual). */
  apiTokenInput: string;
  /** Campo de escrita. Vazio = NÃO vai no corpo (preserva o segredo atual). */
  webhookSecretInput: string;
  /** "Remover token" marcado: envia `apiToken: null` (apaga). */
  removeApiToken: boolean;
  /** "Remover segredo" marcado: envia `webhookSecret: null` (apaga). */
  removeWebhookSecret: boolean;
}

export interface AutoMessageDraft {
  enabled: boolean;
  message: string;
}

export interface ChannelsForm {
  channels: ChannelDraft[];
  distributionMode: DistributionMode;
  autoMessages: { greeting: AutoMessageDraft; offHours: AutoMessageDraft };
  businessHours: {
    timezone: string;
    /** Dia com `null` = fechado. O formulário sempre carrega os 7 dias. */
    days: Record<WeekDay, BusinessHoursRange | null>;
  };
}

const DEFAULT_RANGE: BusinessHoursRange = { start: '08:00', end: '18:00' };

function emptyDraft(channel: ConversationChannel): ChannelDraft {
  return {
    channel,
    displayName: '',
    phoneNumberId: '',
    phoneNumber: '',
    isActive: false,
    apiTokenMasked: null,
    webhookSecretSet: false,
    apiTokenInput: '',
    webhookSecretInput: '',
    removeApiToken: false,
    removeWebhookSecret: false,
  };
}

function draftFrom(channel: TenantChannel): ChannelDraft {
  return {
    channel: channel.channel,
    displayName: channel.displayName ?? '',
    phoneNumberId: channel.phoneNumberId ?? '',
    phoneNumber: channel.phoneNumber ?? '',
    isActive: channel.isActive,
    apiTokenMasked: channel.apiTokenMasked,
    webhookSecretSet: channel.webhookSecretSet,
    apiTokenInput: '',
    webhookSecretInput: '',
    removeApiToken: false,
    removeWebhookSecret: false,
  };
}

/**
 * Resposta do servidor → estado do formulário.
 *
 * Se o laboratório ainda não conectou o WhatsApp, a tela precisa de um cartão
 * vazio para ele conectar — mas esse cartão em branco NÃO vai no `PATCH`
 * enquanto ninguém o tocar (ver `isChannelDirty`), senão o primeiro "salvar"
 * criaria um canal fantasma só por existir um formulário na tela.
 */
export function toForm(settings: ChannelSettingsResponse): ChannelsForm {
  const drafts = settings.channels.map(draftFrom);
  if (!drafts.some((draft) => draft.channel === 'whatsapp')) {
    drafts.unshift(emptyDraft('whatsapp'));
  }

  const days = {} as Record<WeekDay, BusinessHoursRange | null>;
  for (const day of WEEK_DAYS) {
    days[day] = settings.businessHours.days[day] ?? null;
  }

  return {
    channels: drafts,
    distributionMode: settings.distributionMode,
    autoMessages: {
      greeting: {
        enabled: settings.autoMessages.greeting.enabled,
        message: settings.autoMessages.greeting.message ?? '',
      },
      offHours: {
        enabled: settings.autoMessages.offHours.enabled,
        message: settings.autoMessages.offHours.message ?? '',
      },
    },
    businessHours: { timezone: settings.businessHours.timezone, days },
  };
}

export function defaultRangeFor(): BusinessHoursRange {
  return { ...DEFAULT_RANGE };
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** O canal mudou o suficiente para entrar no corpo do PATCH? */
export function isChannelDirty(draft: ChannelDraft, original: TenantChannel | undefined): boolean {
  if (draft.removeApiToken || draft.removeWebhookSecret) return true;
  if (draft.apiTokenInput.trim().length > 0) return true;
  if (draft.webhookSecretInput.trim().length > 0) return true;

  if (!original) {
    // Canal que ainda não existe: só vai se alguém escreveu alguma coisa nele.
    return (
      draft.displayName.trim().length > 0 ||
      draft.phoneNumberId.trim().length > 0 ||
      draft.phoneNumber.trim().length > 0 ||
      draft.isActive
    );
  }

  return (
    trimmedOrNull(draft.displayName) !== original.displayName ||
    trimmedOrNull(draft.phoneNumberId) !== original.phoneNumberId ||
    trimmedOrNull(draft.phoneNumber) !== original.phoneNumber ||
    draft.isActive !== original.isActive
  );
}

/**
 * Um canal do formulário → `UpdateTenantChannelInput`.
 *
 * Os três estados do segredo (§6):
 *   campo em branco  → a CHAVE NÃO EXISTE no objeto  → o servidor preserva
 *   "remover" marcado→ `null`                        → o servidor apaga
 *   texto digitado   → a string                      → o servidor grava
 *
 * String vazia (`""`) nunca é enviada: o servidor recusa com VALIDATION_ERROR,
 * e é assim de propósito — apagar um segredo é um ato explícito.
 */
export function toChannelInput(draft: ChannelDraft): UpdateTenantChannelInput {
  const input: UpdateTenantChannelInput = {
    channel: draft.channel,
    displayName: trimmedOrNull(draft.displayName),
    phoneNumberId: trimmedOrNull(draft.phoneNumberId),
    phoneNumber: trimmedOrNull(draft.phoneNumber),
    isActive: draft.isActive,
  };

  if (draft.removeApiToken) {
    input.apiToken = null;
  } else if (draft.apiTokenInput.trim().length > 0) {
    input.apiToken = draft.apiTokenInput.trim();
  }

  if (draft.removeWebhookSecret) {
    input.webhookSecret = null;
  } else if (draft.webhookSecretInput.trim().length > 0) {
    input.webhookSecret = draft.webhookSecretInput.trim();
  }

  return input;
}

function toAutoMessage(draft: AutoMessageDraft): AutoMessagesSettings['greeting'] {
  return { enabled: draft.enabled, message: trimmedOrNull(draft.message) };
}

/**
 * Formulário → corpo do PATCH.
 *
 * `businessHours` é SUBSTITUIÇÃO, não merge (§6): a tela manda o estado
 * completo e o dia omitido é fechado.
 */
export function buildUpdateRequest(
  form: ChannelsForm,
  settings: ChannelSettingsResponse,
): UpdateChannelSettingsRequest {
  const byChannel = new Map(settings.channels.map((channel) => [channel.channel, channel]));
  const channels = form.channels
    .filter((draft) => isChannelDirty(draft, byChannel.get(draft.channel)))
    .map(toChannelInput);

  const days: Record<string, BusinessHoursRange> = {};
  for (const day of WEEK_DAYS) {
    const range = form.businessHours.days[day];
    if (range) days[day] = range;
  }

  return {
    ...(channels.length > 0 ? { channels } : {}),
    distributionMode: form.distributionMode,
    autoMessages: {
      greeting: toAutoMessage(form.autoMessages.greeting),
      offHours: toAutoMessage(form.autoMessages.offHours),
    },
    businessHours: { timezone: form.businessHours.timezone, days },
  };
}

/**
 * Validação de UX (o servidor valida de novo — CLAUDE.md §3).
 * Chave = caminho do campo, igual ao `details.fields` de API_ERRORS.md.
 */
/**
 * Caminhos de `details.fields` que ESTA tela exibe ao lado do campo
 * (API_ERRORS.md, "Convenção de `details.fields`").
 *
 * A chave de canal é o NOME do canal (`channels.whatsapp.phoneNumber`), a mesma
 * que o backend emite — nunca o índice do array. O que não estiver aqui não tem
 * onde aparecer, e por isso a tela precisa saber disso: um erro de campo que
 * ninguém renderiza tem que virar mensagem geral, senão o admin toma 400 e não
 * vê erro nenhum (ele acha que salvou).
 */
export function renderedFieldPaths(form: ChannelsForm): string[] {
  const paths = [
    'autoMessages.greeting.message',
    'autoMessages.offHours.message',
    'businessHours.timezone',
    ...WEEK_DAYS.map((day) => `businessHours.days.${day}`),
  ];
  for (const draft of form.channels) {
    for (const field of [
      'displayName',
      'phoneNumber',
      'phoneNumberId',
      'apiToken',
      'webhookSecret',
    ]) {
      paths.push(`channels.${draft.channel}.${field}`);
    }
  }
  return paths;
}

/** Caminhos do `details.fields` que a tela NÃO tem onde mostrar. */
export function unrenderedFieldPaths(
  form: ChannelsForm,
  fields: Record<string, string>,
): string[] {
  const rendered = new Set(renderedFieldPaths(form));
  return Object.keys(fields).filter((path) => !rendered.has(path));
}

export function validateForm(form: ChannelsForm): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const key of ['greeting', 'offHours'] as const) {
    const draft = form.autoMessages[key];
    if (draft.enabled && draft.message.trim().length === 0) {
      errors[`autoMessages.${key}.message`] =
        'Mensagem ligada precisa de texto — senão o paciente recebe uma bolha em branco.';
    }
    if (draft.message.trim().length > 1000) {
      errors[`autoMessages.${key}.message`] = 'Máximo de 1000 caracteres.';
    }
  }

  if (form.businessHours.timezone.trim().length === 0) {
    errors['businessHours.timezone'] = 'Informe o fuso horário (ex.: America/Sao_Paulo).';
  }

  for (const day of WEEK_DAYS) {
    const range = form.businessHours.days[day];
    if (range && range.start >= range.end) {
      errors[`businessHours.days.${day}`] = 'O início precisa ser antes do fim.';
    }
  }

  for (const draft of form.channels) {
    const token = draft.apiTokenInput.trim();
    if (token.length > 0 && (token.length < 10 || token.length > 500)) {
      errors[`channels.${draft.channel}.apiToken`] = 'O token tem de 10 a 500 caracteres.';
    }
    const secret = draft.webhookSecretInput.trim();
    if (secret.length > 0 && (secret.length < 16 || secret.length > 255)) {
      errors[`channels.${draft.channel}.webhookSecret`] =
        'O segredo do webhook tem de 16 a 255 caracteres.';
    }
  }

  return errors;
}
