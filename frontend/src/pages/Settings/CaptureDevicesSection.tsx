import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CAPTURE_DEVICE_NAME_MAX,
  type CaptureDevice,
  type CaptureDeviceStatus,
  type CapturePairingCode,
} from '@crm-lab/shared';
import {
  isApiError,
  useCaptureDevices,
  useCreateCaptureDevice,
  useRenewPairingCode,
  useRevokeCaptureDevice,
} from '@/api';
import { DataTable, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, useToast } from '@/components/ui';
import type { ChipTone } from '@/components/ui/Chip';
import { formatRelativeDate } from '@/lib/format';
import { formatPairingCode } from '@/lib/pairing-code';

/**
 * Dispositivos de captura — seção de Canais & Equipe, abaixo de Equipe
 * (PAGES.md §10, CRMLAB-184, D-326, API_CONTRACTS §15.1).
 *
 * Admin edita, gestor lê: para o gestor não existe botão nenhum. O código de
 * pareamento em claro só aparece no modal logo depois de criar/renovar — a
 * listagem nunca o traz.
 */

export const REVOKE_CONFIRM =
  'O celular para de enviar na hora. As fotos que já estão na fila continuam.';

const STATUS: Record<CaptureDeviceStatus, { label: string; tone: ChipTone }> = {
  pending: { label: 'Aguardando pareamento', tone: 'attention' },
  active: { label: 'Ativo', tone: 'positive' },
  revoked: { label: 'Revogado', tone: 'inactive' },
};

interface PairingView {
  deviceName: string;
  pairing: CapturePairingCode;
}

/** `mm:ss` até `expiresAt`; para em `00:00`. */
function useCountdown(expiresAt: string): number {
  const target = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);
  return Math.max(0, Math.floor((target - now) / 1000));
}

function PairingModal({ view, onClose }: { view: PairingView; onClose: () => void }) {
  const remaining = useCountdown(view.pairing.expiresAt);
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
  const seconds = String(remaining % 60).padStart(2, '0');
  const url = `${window.location.origin}/digitalizar`;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Parear ${view.deviceName}`}
      footer={<Button onClick={onClose}>Pronto</Button>}
    >
      <div className="flex flex-col gap-lg font-body">
        <div className="flex flex-col items-center gap-xs rounded-lg bg-surface p-lg">
          <span className="text-caption text-neutral-700">Código de pareamento</span>
          <strong
            data-testid="pairing-code"
            className="font-heading text-display tracking-widest text-text"
          >
            {formatPairingCode(view.pairing.code)}
          </strong>
          {remaining > 0 ? (
            <span className="text-caption text-neutral-700" aria-live="polite">
              Vale por {minutes}:{seconds} · uso único
            </span>
          ) : (
            <span role="alert" className="text-caption font-semibold text-danger-ink">
              Código vencido. Feche e use “Gerar novo código”.
            </span>
          )}
        </div>
        <ol className="m-0 flex flex-col gap-sm pl-xl text-body text-text">
          <li>
            No iPhone, abra <strong className="break-all">{url}</strong> no Safari.
          </li>
          <li>
            Toque em <strong>Compartilhar</strong> › <strong>Adicionar à Tela de Início</strong>.
          </li>
          <li>
            Abra pelo ícone <strong>Digitalizar</strong> na tela de início.
          </li>
          <li>Digite o código acima.</li>
        </ol>
      </div>
    </Modal>
  );
}

function NewDeviceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (view: PairingView) => void;
}) {
  const create = useCreateCaptureDevice();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  function submit(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault();
    if (trimmed.length === 0) {
      setError('Informe um nome.');
      return;
    }
    setError(null);
    create.mutate(
      { name: trimmed },
      {
        onSuccess: ({ device, pairing }) => onCreated({ deviceName: device.name, pairing }),
        onError: (caught: unknown) =>
          setError(isApiError(caught) ? caught.message : 'Não foi possível cadastrar.'),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Novo dispositivo de captura"
      footer={
        <>
          <Button onClick={() => submit()} loading={create.isPending}>
            Gerar código
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancelar
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Input
          label="Nome do dispositivo"
          placeholder="Celular recepção"
          value={name}
          maxLength={CAPTURE_DEVICE_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          error={error ?? undefined}
          autoFocus
        />
      </form>
    </Modal>
  );
}

export function CaptureDevicesSection({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const devicesQuery = useCaptureDevices();
  const renew = useRenewPairingCode();
  const revoke = useRevokeCaptureDevice();
  const [creating, setCreating] = useState(false);
  const [pairingView, setPairingView] = useState<PairingView | null>(null);

  const columns = useMemo<Array<DataTableColumn<CaptureDevice>>>(() => {
    function renewCode(device: CaptureDevice): void {
      renew.mutate(device.id, {
        onSuccess: (pairing) => setPairingView({ deviceName: device.name, pairing }),
        onError: (error: unknown) => {
          const revoked =
            isApiError(error) && error.code === 'CONFLICT' && error.details?.reason === 'device_revoked';
          toast(
            revoked
              ? 'Este dispositivo foi revogado. Cadastre um novo.'
              : 'Não foi possível gerar o código.',
            { tone: 'attention' },
          );
        },
      });
    }

    function revokeDevice(device: CaptureDevice): void {
      if (!window.confirm(REVOKE_CONFIRM)) return;
      revoke.mutate(device.id, {
        onSuccess: () => toast(`${device.name} revogado.`, { tone: 'neutral' }),
        onError: () => toast('Não foi possível revogar.', { tone: 'attention' }),
      });
    }

    const base: Array<DataTableColumn<CaptureDevice>> = [
      {
        key: 'name',
        header: 'Nome',
        minWidth: 180,
        render: (device) => <span className="font-semibold text-text">{device.name}</span>,
      },
      {
        key: 'status',
        header: 'Situação',
        render: (device) => (
          <Chip tone={STATUS[device.status].tone}>{STATUS[device.status].label}</Chip>
        ),
      },
      {
        key: 'lastUsedAt',
        header: 'Último envio',
        render: (device) => (
          <span>{device.lastUsedAt ? formatRelativeDate(device.lastUsedAt) : 'Nunca'}</span>
        ),
      },
      {
        key: 'pendingScans',
        header: 'Fotos na fila',
        align: 'right',
        render: (device) => <span>{device.pendingScans}</span>,
      },
    ];
    if (!canEdit) return base;
    return [
      ...base,
      {
        key: 'actions',
        header: 'Ações',
        align: 'right',
        render: (device) =>
          device.status === 'revoked' ? null : (
            <div className="flex justify-end gap-xs">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => renewCode(device)}
                disabled={renew.isPending}
              >
                Gerar novo código
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => revokeDevice(device)}
                disabled={revoke.isPending}
              >
                Revogar
              </Button>
            </div>
          ),
      },
    ];
  }, [canEdit, renew, revoke, toast]);

  return (
    <section
      aria-labelledby="capture-devices-title"
      className="flex flex-col gap-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="flex items-start justify-between gap-md">
        <div className="flex flex-col gap-xs">
          <h2 id="capture-devices-title" className="m-0 font-heading text-section text-text">
            Dispositivos de captura
          </h2>
          <p className="m-0 font-body text-caption text-neutral-600">
            Celulares que mandam fotos para a fila Digitalizações pelo atalho Digitalizar, sem login.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setCreating(true)}>
            Novo dispositivo
          </Button>
        )}
      </div>

      {devicesQuery.isError ? (
        <p role="alert" className="m-0 font-body text-caption text-danger-ink">
          Não foi possível carregar os dispositivos.
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={devicesQuery.data?.devices ?? []}
          rowKey={(device) => device.id}
          emptyMessage={devicesQuery.isLoading ? 'Carregando…' : 'Nenhum dispositivo cadastrado'}
          minWidth={canEdit ? 720 : 520}
        />
      )}

      {creating && (
        <NewDeviceModal
          onClose={() => setCreating(false)}
          onCreated={(view) => {
            setCreating(false);
            setPairingView(view);
          }}
        />
      )}
      {pairingView && <PairingModal view={pairingView} onClose={() => setPairingView(null)} />}
    </section>
  );
}
