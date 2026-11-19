import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { PAIRING_CODE_LENGTH, normalizePairingCode, type CaptureSession } from '@crm-lab/shared';
import { captureApi, isApiError } from '@/api';
import { cn } from '@/components/ui';
import { formatPairingCode } from '@/lib/pairing-code';
import { blobToBase64, isIos, isStandalone, reduceScanImage } from './capture-helpers';
import { usePwaHead } from './usePwaHead';

/**
 * Digitalizar pelo celular — `/digitalizar` (PAGES.md §24, CRMLAB-184, D-326).
 *
 * Fora do `AppShell` e sem sessão de usuário: quem fala com a API é o
 * dispositivo pareado (cookie `crm_capture`, `src/api/capture.ts`). A foto vai
 * para a fila **Digitalizações**; quem manda ao paciente é o atendimento.
 *
 * Três telas: instalar (aberta no navegador, fora da tela de início), código
 * (instalada e não pareada) e câmera (pareada). As fotos ficam no estado da
 * página: se o celular for desconectado no meio do envio, voltam depois do
 * novo código.
 */

export const MESSAGES = {
  invalidCode: 'Código inválido ou vencido. Peça um novo para quem administra o CRM.',
  tooManyAttempts: 'Muitas tentativas. Espere alguns minutos.',
  unpaired: 'Este celular foi desconectado do CRM. Digite um novo código.',
  queueFull:
    'A fila deste celular está cheia (100 fotos). Peça para usarem ou descartarem as fotos no CRM.',
  offline: 'Sem conexão. A foto continua aqui.',
  sent: 'Enviado ✓ — já está em Digitalizações no CRM',
  tooLarge: 'Foto grande demais mesmo reduzida (acima de 5 MB). Tire de novo, mais de perto.',
  unreadable: 'Não foi possível ler esta foto. Tire de novo.',
  uploadFailed: 'Não foi possível enviar. Toque em "Tentar de novo".',
  pairFailed: 'Não foi possível parear agora. Tente de novo.',
  pairOffline: 'Sem conexão. Confira a internet e tente de novo.',
} as const;

const SENT_NOTICE_MS = 2000;

type Screen =
  | { kind: 'checking' }
  | { kind: 'install'; canContinue: boolean }
  | { kind: 'code'; notice: string | null }
  | { kind: 'paired'; session: CaptureSession }
  | { kind: 'unreachable' };

type PhotoStatus = 'preparing' | 'ready' | 'sending' | 'sent' | 'failed' | 'invalid';

interface Photo {
  id: string;
  previewUrl: string;
  /** JPEG já reduzido; `null` enquanto prepara ou quando não pode subir. */
  blob: Blob | null;
  status: PhotoStatus;
  /** Aviso da foto (inválida ou falhou). */
  message: string | null;
}

type UploadOutcome = 'sent' | 'failed' | 'stop';

const SAFE_AREA: CSSProperties = {
  paddingTop: 'max(var(--gap-lg), env(safe-area-inset-top))',
  paddingBottom: 'max(var(--gap-lg), env(safe-area-inset-bottom))',
  paddingLeft: 'max(var(--gap-lg), env(safe-area-inset-left))',
  paddingRight: 'max(var(--gap-lg), env(safe-area-inset-right))',
};

const BIG_BUTTON =
  'flex min-h-[64px] w-full cursor-pointer items-center justify-center gap-sm rounded-lg border font-body ' +
  'text-section font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = 'border-transparent bg-accent text-bg active:bg-accent-600';
const SECONDARY = 'border-neutral-300 bg-surface text-text active:bg-neutral-200';

let photoSequence = 0;

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col bg-bg font-body text-text" style={SAFE_AREA}>
      <div className="mx-auto flex w-full max-w-modal flex-1 flex-col gap-lg">{children}</div>
    </main>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <h1 className="m-0 font-heading text-display text-text">{children}</h1>;
}

function ShareIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="inline-block align-text-bottom text-accent"
    >
      <path d="M12 3v12" />
      <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
      <path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function InstallScreen({ canContinue, onContinue }: { canContinue: boolean; onContinue: () => void }) {
  return (
    <Shell>
      <Title>Digitalizar</Title>
      <p className="m-0 text-body text-neutral-700">
        Instale o atalho na tela de início para tirar fotos e mandar para o CRM.
      </p>
      <ol className="m-0 flex list-none flex-col gap-md p-0" aria-label="Como instalar">
        <li className="flex items-start gap-md rounded-lg bg-surface p-lg text-label">
          <span className="font-semibold text-accent-800">1</span>
          <span>
            Toque em <strong>Compartilhar</strong> <ShareIcon /> na barra do navegador.
          </span>
        </li>
        <li className="flex items-start gap-md rounded-lg bg-surface p-lg text-label">
          <span className="font-semibold text-accent-800">2</span>
          <span>
            Escolha <strong>Adicionar à Tela de Início</strong>.
          </span>
        </li>
        <li className="flex items-start gap-md rounded-lg bg-surface p-lg text-label">
          <span className="font-semibold text-accent-800">3</span>
          <span>
            Abra pelo ícone <strong>Digitalizar</strong> e digite o código que o CRM mostrou.
          </span>
        </li>
      </ol>
      {canContinue ? (
        <button type="button" className={cn(BIG_BUTTON, SECONDARY)} onClick={onContinue}>
          Continuar sem instalar
        </button>
      ) : (
        <p className="m-0 text-caption text-neutral-600">
          No iPhone, o código só funciona com o atalho aberto pela tela de início.
        </p>
      )}
    </Shell>
  );
}

function CodeScreen({
  notice,
  onPaired,
}: {
  notice: string | null;
  onPaired: (session: CaptureSession) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const code = normalizePairingCode(value);
  const complete = code.length === PAIRING_CODE_LENGTH;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onPaired(await captureApi.pair({ code }));
    } catch (caught: unknown) {
      if (isApiError(caught) && caught.code === 'PAIRING_CODE_INVALID') setError(MESSAGES.invalidCode);
      else if (isApiError(caught) && caught.statusCode === 429) setError(MESSAGES.tooManyAttempts);
      else if (isApiError(caught)) setError(MESSAGES.pairFailed);
      else setError(MESSAGES.pairOffline);
      setSubmitting(false);
    }
  }

  return (
    <Shell>
      <Title>Digitalizar</Title>
      {notice && (
        <p role="status" className="m-0 rounded-lg bg-accent-100 p-lg text-label text-accent-900">
          {notice}
        </p>
      )}
      <form className="flex flex-col gap-lg" onSubmit={(event) => void submit(event)}>
        <label htmlFor="pairing-code" className="text-label font-semibold">
          Código de pareamento
        </label>
        <input
          id="pairing-code"
          value={value}
          onChange={(event) => {
            setValue(formatPairingCode(event.target.value));
            setError(null);
          }}
          placeholder="XXXX-XXXX"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          maxLength={PAIRING_CODE_LENGTH + 1}
          aria-invalid={error !== null}
          aria-describedby="pairing-help"
          className="min-h-[64px] w-full rounded-lg border-2 border-neutral-300 bg-bg text-center font-heading text-display tracking-widest text-text outline-none focus:border-accent"
        />
        <p id="pairing-help" className="m-0 text-caption text-neutral-600">
          Quem administra o CRM gera o código em Canais &amp; Equipe › Dispositivos de captura.
        </p>
        {error && (
          <p role="alert" className="m-0 text-label font-semibold text-danger-ink">
            {error}
          </p>
        )}
        <button type="submit" className={cn(BIG_BUTTON, PRIMARY)} disabled={!complete || submitting}>
          {submitting ? 'Conectando…' : 'Conectar'}
        </button>
      </form>
    </Shell>
  );
}

function statusLabel(photo: Photo): string | null {
  switch (photo.status) {
    case 'preparing':
      return 'Preparando…';
    case 'sending':
      return 'Enviando…';
    case 'sent':
      return 'Enviada ✓';
    default:
      return null;
  }
}

function PhotoThumb({
  photo,
  index,
  busy,
  onRemove,
  onRetry,
}: {
  photo: Photo;
  index: number;
  busy: boolean;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const label = statusLabel(photo);
  return (
    <li
      data-testid="capture-photo"
      data-status={photo.status}
      className="flex w-[112px] flex-[0_0_112px] list-none flex-col gap-xs"
    >
      <div
        className={cn(
          'relative h-[112px] w-[112px] overflow-hidden rounded-md border-2 bg-surface',
          photo.status === 'failed' || photo.status === 'invalid' ? 'border-danger' : 'border-neutral-300',
        )}
      >
        <img src={photo.previewUrl} alt={`Foto ${index + 1}`} className="h-full w-full object-cover" />
        {!busy && photo.status !== 'sending' && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remover foto ${index + 1}`}
            className="absolute right-xs top-xs flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-pill border-none bg-neutral-800 p-0 text-section leading-none text-bg"
          >
            ×
          </button>
        )}
      </div>
      {label && <span className="text-caption text-neutral-700">{label}</span>}
      {photo.message && (
        <span role="alert" className="text-caption font-semibold text-danger-ink">
          {photo.message}
        </span>
      )}
      {photo.status === 'failed' && !busy && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[44px] cursor-pointer rounded-md border border-neutral-400 bg-bg px-sm font-body text-caption font-semibold text-text"
        >
          Tentar de novo
        </button>
      )}
    </li>
  );
}

export default function Digitalizar() {
  usePwaHead();

  const [screen, setScreen] = useState<Screen>({ kind: 'checking' });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [sentNotice, setSentNotice] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<Photo[]>(photos);
  photosRef.current = photos;

  const checkSession = useCallback(async (): Promise<void> => {
    setScreen({ kind: 'checking' });
    try {
      setScreen({ kind: 'paired', session: await captureApi.session() });
    } catch (error: unknown) {
      if (isApiError(error) && error.code === 'CAPTURE_DEVICE_UNPAIRED') {
        setScreen({ kind: 'code', notice: null });
      } else {
        setScreen({ kind: 'unreachable' });
      }
    }
  }, []);

  // Ao abrir: no navegador (fora da tela de início) só ensina a instalar. No
  // iOS não deixa seguir — o app instalado não vê o cookie do Safari (D-326 item 4).
  useEffect(() => {
    if (isStandalone()) {
      void checkSession();
      return;
    }
    setScreen({ kind: 'install', canContinue: !isIos() });
  }, [checkSession]);

  // Object URLs das miniaturas saem com a página.
  useEffect(
    () => () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.previewUrl);
    },
    [],
  );

  // "Enviado ✓" por 2 s e volta ao estado inicial.
  useEffect(() => {
    if (!sentNotice) return undefined;
    const timer = setTimeout(() => setSentNotice(false), SENT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [sentNotice]);

  function patchPhoto(id: string, patch: Partial<Photo>): void {
    setPhotos((current) => current.map((photo) => (photo.id === id ? { ...photo, ...patch } : photo)));
  }

  function removePhoto(id: string): void {
    setPhotos((current) => {
      const gone = current.find((photo) => photo.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((photo) => photo.id !== id);
    });
  }

  async function addPhoto(file: File): Promise<void> {
    photoSequence += 1;
    const id = `photo-${photoSequence}`;
    setSentNotice(false);
    setBanner(null);
    setPhotos((current) => [
      ...current,
      { id, previewUrl: URL.createObjectURL(file), blob: null, status: 'preparing', message: null },
    ]);
    try {
      const blob = await reduceScanImage(file);
      patchPhoto(
        id,
        blob
          ? { blob, status: 'ready' }
          : { status: 'invalid', message: MESSAGES.tooLarge },
      );
    } catch {
      patchPhoto(id, { status: 'invalid', message: MESSAGES.unreadable });
    }
  }

  async function upload(photo: Photo): Promise<UploadOutcome> {
    if (!photo.blob) return 'failed';
    patchPhoto(photo.id, { status: 'sending', message: null });
    try {
      const contentBase64 = await blobToBase64(photo.blob);
      await captureApi.uploadScan({ mimeType: 'image/jpeg', contentBase64 });
      patchPhoto(photo.id, { status: 'sent' });
      return 'sent';
    } catch (error: unknown) {
      if (isApiError(error) && error.code === 'CAPTURE_DEVICE_UNPAIRED') {
        patchPhoto(photo.id, { status: 'failed' });
        setScreen({ kind: 'code', notice: MESSAGES.unpaired });
        return 'stop';
      }
      if (isApiError(error) && error.code === 'CONFLICT' && error.details?.reason === 'scan_queue_full') {
        patchPhoto(photo.id, { status: 'failed' });
        setBanner(MESSAGES.queueFull);
        return 'stop';
      }
      if (isApiError(error)) {
        patchPhoto(photo.id, { status: 'failed', message: MESSAGES.uploadFailed });
      } else {
        patchPhoto(photo.id, { status: 'failed' });
        setBanner(MESSAGES.offline);
      }
      return 'failed';
    }
  }

  /** Uma por vez, na ordem da faixa; falha de uma não para as outras. */
  async function send(targets: Photo[]): Promise<void> {
    if (targets.length === 0 || sending) return;
    setSending(true);
    setBanner(null);
    let allSent = true;
    for (const photo of targets) {
      const outcome = await upload(photo);
      if (outcome !== 'sent') allSent = false;
      if (outcome === 'stop') break;
    }
    // As enviadas saem da faixa; ficam as que falharam (com "Tentar de novo").
    setPhotos((current) => {
      for (const photo of current) if (photo.status === 'sent') URL.revokeObjectURL(photo.previewUrl);
      return current.filter((photo) => photo.status !== 'sent');
    });
    setSending(false);
    if (allSent) setSentNotice(true);
  }

  if (screen.kind === 'checking') {
    return (
      <Shell>
        <Title>Digitalizar</Title>
        <p className="m-0 text-body text-neutral-600" role="status">
          Conectando…
        </p>
      </Shell>
    );
  }

  if (screen.kind === 'install') {
    return (
      <InstallScreen
        canContinue={screen.canContinue}
        onContinue={() => void checkSession()}
      />
    );
  }

  if (screen.kind === 'unreachable') {
    return (
      <Shell>
        <Title>Digitalizar</Title>
        <p role="alert" className="m-0 text-label text-danger-ink">
          Sem conexão com o CRM agora.
        </p>
        <button type="button" className={cn(BIG_BUTTON, SECONDARY)} onClick={() => void checkSession()}>
          Tentar de novo
        </button>
      </Shell>
    );
  }

  if (screen.kind === 'code') {
    return (
      <CodeScreen
        notice={screen.notice}
        onPaired={(session) => setScreen({ kind: 'paired', session })}
      />
    );
  }

  const pending = photos.filter((photo) => photo.status === 'ready' || photo.status === 'failed');
  const preparing = photos.some((photo) => photo.status === 'preparing');

  return (
    <Shell>
      <header className="flex flex-col gap-xs">
        <Title>Digitalizar</Title>
        <p className="m-0 text-label text-neutral-700">
          <strong className="text-text">{screen.session.tenantName}</strong> · {screen.session.deviceName}
        </p>
      </header>

      {sentNotice && (
        <p role="status" className="m-0 rounded-lg bg-accent2-200 p-lg text-label font-semibold text-accent2-800">
          {MESSAGES.sent}
        </p>
      )}
      {banner && (
        <p role="alert" className="m-0 rounded-lg bg-danger-soft p-lg text-label font-semibold text-danger-ink">
          {banner}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="capture-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void addPhoto(file);
        }}
      />

      {photos.length === 0 ? (
        <button
          type="button"
          className={cn(BIG_BUTTON, PRIMARY, 'min-h-[160px] flex-col')}
          onClick={() => inputRef.current?.click()}
        >
          <CameraIcon />
          Tirar foto
        </button>
      ) : (
        <>
          <ul aria-label="Fotos para enviar" className="m-0 flex gap-md overflow-x-auto p-0 pb-sm">
            {photos.map((photo, index) => (
              <PhotoThumb
                key={photo.id}
                photo={photo}
                index={index}
                busy={sending}
                onRemove={() => removePhoto(photo.id)}
                onRetry={() => void send([photo])}
              />
            ))}
          </ul>
          <button
            type="button"
            className={cn(BIG_BUTTON, SECONDARY)}
            disabled={sending}
            onClick={() => inputRef.current?.click()}
          >
            + Outra foto
          </button>
          <button
            type="button"
            className={cn(BIG_BUTTON, PRIMARY)}
            disabled={sending || preparing || pending.length === 0}
            onClick={() => void send(pending)}
          >
            {sending ? 'Enviando…' : `Enviar (${pending.length})`}
          </button>
        </>
      )}
    </Shell>
  );
}
