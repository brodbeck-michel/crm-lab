import { useState } from 'react';
import type { Scan } from '@crm-lab/shared';
import { useDiscardScan, useScanList } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState, ImageLightbox } from '@/components/shared';
import { Button, useToast } from '@/components/ui';
import { useAuthenticatedMedia } from '@/hooks/useAuthenticatedMedia';
import { formatDateTime, formatRelativeDate } from '@/lib/format';

/**
 * Digitalizações — `/scans` (PAGES.md §24a, CRMLAB-184, D-327).
 *
 * A fila das fotos do celular pareado numa tela própria: ver, ampliar, baixar
 * e descartar. Enviar ao paciente continua sendo pelo clipe do Composer (§2).
 * Sem WS: `useScanList` recarrega ao montar; há também o botão Atualizar.
 */

const EMPTY_MESSAGE = 'Nenhuma foto. Tire pelo atalho Digitalizar no celular.';
const DISCARD_CONFIRM = 'Descartar esta foto? Ela sai da fila Digitalizações para todo mundo.';

function ScanCard({
  scan,
  onOpen,
  onDiscard,
  discarding,
}: {
  scan: Scan;
  onOpen: () => void;
  onDiscard: () => void;
  discarding: boolean;
}) {
  const media = useAuthenticatedMedia(scan.contentUrl);
  const when = formatRelativeDate(scan.createdAt);
  return (
    <li data-testid="scan-card" className="flex list-none flex-col gap-xs">
      <div className="relative aspect-square overflow-hidden rounded-md border border-neutral-300 bg-surface">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Ampliar foto de ${when} · ${scan.deviceName}`}
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

function ScanLightbox({
  scan,
  onClose,
  onPrev,
  onNext,
}: {
  scan: Scan;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const media = useAuthenticatedMedia(scan.contentUrl);
  return (
    <ImageLightbox
      open
      src={media.objectUrl}
      loading={!media.objectUrl && !media.isError}
      error={media.isError}
      fileName={scan.fileName}
      title={`${formatDateTime(scan.createdAt)} · ${scan.deviceName}`}
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
    />
  );
}

export default function Scans() {
  const { toast } = useToast();
  const scansQuery = useScanList();
  const discard = useDiscardScan();
  const [openId, setOpenId] = useState<string | null>(null);

  const scans = scansQuery.data?.scans ?? [];
  const openIndex = scans.findIndex((scan) => scan.id === openId);
  const openScan = openIndex >= 0 ? scans[openIndex] : undefined;

  function handleDiscard(scan: Scan): void {
    if (!window.confirm(DISCARD_CONFIRM)) return;
    discard.mutate(scan.id, {
      onError: () => toast('Não foi possível descartar a foto.', { tone: 'attention' }),
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="Digitalizações"
        description="Fotos tiradas pelo celular do laboratório. Para enviar ao paciente, use o clipe › Digitalizações na conversa."
        actions={
          <Button
            variant="secondary"
            onClick={() => void scansQuery.refetch()}
            loading={scansQuery.isFetching && !scansQuery.isLoading}
          >
            Atualizar
          </Button>
        }
      />

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
          className="m-0 grid grid-cols-2 gap-md p-0 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6"
        >
          {scans.map((scan) => (
            <ScanCard
              key={scan.id}
              scan={scan}
              onOpen={() => setOpenId(scan.id)}
              onDiscard={() => handleDiscard(scan)}
              discarding={discard.isPending && discard.variables === scan.id}
            />
          ))}
        </ul>
      )}

      {openScan && (
        <ScanLightbox
          key={openScan.id}
          scan={openScan}
          onClose={() => setOpenId(null)}
          onPrev={openIndex > 0 ? () => setOpenId(scans[openIndex - 1]?.id ?? null) : undefined}
          onNext={
            openIndex < scans.length - 1
              ? () => setOpenId(scans[openIndex + 1]?.id ?? null)
              : undefined
          }
        />
      )}
    </PageContainer>
  );
}
