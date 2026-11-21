import { useState } from 'react';
import type { Scan } from '@crm-lab/shared';
import { fetchAuthenticatedBlob, resolveMediaUrl, useDiscardScan, useScanList } from '@/api';
import { EmptyState, Modal } from '@/components/shared';
import { Button, cn, useToast } from '@/components/ui';
import { useAuthenticatedMedia } from '@/hooks/useAuthenticatedMedia';
import { formatRelativeDate } from '@/lib/format';

/**
 * Seletor da fila **Digitalizações** (PAGES.md §2 "Anexos com prévia",
 * CRMLAB-184, D-327). Montado só enquanto aberto: `GET /scans` recarrega a
 * cada abertura (sem WS para a fila).
 *
 * "Usar" baixa as fotos escolhidas (busca autenticada, como a mídia do
 * atendimento) e devolve `File` + `scanId`: a prévia (`AttachmentPreview`)
 * mostra a cópia e o envio manda só o `scanId`.
 */

export const SCAN_GONE_MESSAGE = 'Essa foto já foi usada ou venceu';
const EMPTY_MESSAGE = 'Nenhuma foto. Tire pelo atalho Digitalizar no celular.';
const DISCARD_CONFIRM = 'Descartar esta foto? Ela sai da fila Digitalizações para todo mundo.';

export interface PickedScan {
  scanId: string;
  file: File;
}

export interface ScanPickerProps {
  onClose: () => void;
  /** Só com pelo menos uma foto baixada. */
  onUse: (picked: PickedScan[]) => void;
}

function ScanTile({
  scan,
  selected,
  onToggle,
  onDiscard,
  discarding,
}: {
  scan: Scan;
  selected: boolean;
  onToggle: () => void;
  onDiscard: () => void;
  discarding: boolean;
}) {
  const media = useAuthenticatedMedia(scan.contentUrl);
  const when = formatRelativeDate(scan.createdAt);
  return (
    <li data-testid="scan-tile" className="flex list-none flex-col gap-xs">
      <div
        className={cn(
          'relative aspect-square overflow-hidden rounded-md border-2 bg-surface',
          selected ? 'border-accent' : 'border-neutral-300',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          aria-label={`Selecionar foto de ${when} · ${scan.deviceName}`}
          className="flex h-full w-full cursor-pointer items-center justify-center border-none bg-transparent p-0"
        >
          {media.objectUrl ? (
            <img src={media.objectUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="font-body text-caption text-neutral-600">
              {media.isError ? 'Sem prévia' : 'Carregando…'}
            </span>
          )}
        </button>
        {selected && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-xs top-xs flex h-[24px] w-[24px] items-center justify-center rounded-pill bg-accent font-body text-caption font-bold text-bg"
          >
            ✓
          </span>
        )}
        <button
          type="button"
          onClick={onDiscard}
          disabled={discarding}
          aria-label={`Descartar foto de ${when}`}
          title="Descartar"
          className="absolute right-xs top-xs flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-pill border-none bg-neutral-800 p-0 text-bg disabled:opacity-50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
        </button>
      </div>
      <span className="truncate font-body text-caption text-neutral-700">
        {when} · {scan.deviceName}
      </span>
    </li>
  );
}

export function ScanPicker({ onClose, onUse }: ScanPickerProps) {
  const { toast } = useToast();
  const scansQuery = useScanList();
  const discard = useDiscardScan();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const scans = scansQuery.data?.scans ?? [];
  // A ordem de uso é a da grade (mais nova primeiro), não a do clique.
  const chosen = scans.filter((scan) => selected.includes(scan.id));

  function toggle(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function handleDiscard(scan: Scan): void {
    if (!window.confirm(DISCARD_CONFIRM)) return;
    setSelected((current) => current.filter((value) => value !== scan.id));
    discard.mutate(scan.id, {
      onError: () => toast('Não foi possível descartar a foto.', { tone: 'attention' }),
    });
  }

  async function use(): Promise<void> {
    if (chosen.length === 0 || loading) return;
    setLoading(true);
    const picked: PickedScan[] = [];
    let gone = false;
    for (const scan of chosen) {
      try {
        const { blob } = await fetchAuthenticatedBlob(resolveMediaUrl(scan.contentUrl));
        picked.push({
          scanId: scan.id,
          file: new File([blob], scan.fileName, { type: scan.mimeType || blob.type }),
        });
      } catch {
        gone = true;
      }
    }
    setLoading(false);
    if (gone) toast(SCAN_GONE_MESSAGE, { tone: 'attention' });
    if (picked.length > 0) onUse(picked);
    else void scansQuery.refetch();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Digitalizações"
      footer={
        <>
          <Button onClick={() => void use()} disabled={chosen.length === 0} loading={loading}>
            {`Usar (${chosen.length})`}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
        </>
      }
    >
      {scansQuery.isLoading ? (
        <p className="m-0 font-body text-body text-neutral-600">Carregando fotos…</p>
      ) : scansQuery.isError ? (
        <div className="flex flex-col items-start gap-sm">
          <p role="alert" className="m-0 font-body text-body text-danger-ink">
            Não foi possível carregar as fotos.
          </p>
          <Button variant="secondary" size="sm" onClick={() => void scansQuery.refetch()}>
            Tentar de novo
          </Button>
        </div>
      ) : scans.length === 0 ? (
        <EmptyState message={EMPTY_MESSAGE} />
      ) : (
        <ul
          aria-label="Fotos da fila"
          className="m-0 grid grid-cols-2 gap-md p-0 sm:grid-cols-3 md:grid-cols-4"
        >
          {scans.map((scan) => (
            <ScanTile
              key={scan.id}
              scan={scan}
              selected={selected.includes(scan.id)}
              onToggle={() => toggle(scan.id)}
              onDiscard={() => handleDiscard(scan)}
              discarding={discard.isPending && discard.variables === scan.id}
            />
          ))}
        </ul>
      )}
    </Modal>
  );
}
