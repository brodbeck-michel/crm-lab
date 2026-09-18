import { useEffect, useRef, useState } from 'react';
import type { IsoDateTime, WhatsAppConnectionStatus } from '@crm-lab/shared';
import { isApiError } from '@/api/client';
import { useWhatsAppConnect, useWhatsAppQr } from '@/api/channels';
import { Modal } from '@/components/shared';
import { Button, useToast } from '@/components/ui';

/**
 * Modal "plugin" de conexão do WhatsApp por QR (Onda 7 — Bloco B).
 * `docs/api/API_CONTRACTS.md` §6.1. Pareia o número próprio do laboratório
 * via Evolution API — a ALTERNATIVA à API oficial da Meta, não uma
 * substituição: o termo de risco existe porque este caminho não tem a
 * garantia de conta comercial da Meta por trás.
 *
 * Comportamentos do backend que este componente respeita ao pé da letra
 * (Task 5, dois rounds de correção):
 *  - `GET /qr` num canal já conectado devolve `status: "connected"` com
 *    `qrcode: null` — é ASSIM que o polling termina, não um QR nulo é falha.
 *  - `POST /connect` aceita aceite já gravado OU `acceptTerms: true` no
 *    corpo. Numa reconexão (`acceptedTermsAt` já setado) o checkbox não é
 *    exigido, mas o corpo enviado continua `{ acceptTerms: true }` — o tipo
 *    compartilhado (`WhatsAppQrConnectRequest`) não tem variante parcial, e
 *    reenviar `true` num aceite já registrado é inofensivo (o servidor aceita
 *    os dois caminhos, então mandar o mais permissivo sempre funciona).
 *  - `503 CHANNEL_QR_UNAVAILABLE` é estado real de operador (gateway sem
 *    configuração), não uma falha transitória — a tela mostra mensagem
 *    honesta, nunca um spinner que não resolve.
 */

export interface WhatsAppConnectModalProps {
  open: boolean;
  onClose: () => void;
  /** `TenantChannel.acceptedTermsAt`. Presente ⇒ reconexão, pula o checkbox. */
  acceptedTermsAt?: IsoDateTime | null;
}

const GATEWAY_UNAVAILABLE_MESSAGE =
  'O serviço de conexão por QR está indisponível no momento. Tente novamente em instantes.';

function connectErrorMessage(error: unknown): string {
  if (isApiError(error) && error.code === 'CHANNEL_QR_UNAVAILABLE') {
    return GATEWAY_UNAVAILABLE_MESSAGE;
  }
  return 'Não foi possível iniciar a conexão. Tente novamente.';
}

export function WhatsAppConnectModal({ open, onClose, acceptedTermsAt }: WhatsAppConnectModalProps) {
  const { toast } = useToast();
  const alreadyAccepted = acceptedTermsAt != null;

  const [accepted, setAccepted] = useState(false);
  const [started, setStarted] = useState(false);
  const [reachedPairing, setReachedPairing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = useWhatsAppConnect();
  const qr = useWhatsAppQr({ enabled: started });
  const qrData = qr.data;

  const previousStatus = useRef<WhatsAppConnectionStatus | null>(null);

  // Reação a MUDANÇA de status — não a cada render com o mesmo status parado
  // (senão um "connected" que persiste por vários renders repetiria o toast
  // e chamaria `onClose` de novo a cada um deles).
  useEffect(() => {
    const status = qrData?.status;
    if (!status || status === previousStatus.current) return;
    previousStatus.current = status;

    if (status === 'pairing') setReachedPairing(true);
    if (status === 'connected' && started) {
      toast('WhatsApp conectado.', { tone: 'positive' });
      onClose();
    }
  }, [qrData?.status, started, onClose, toast]);

  // Reabrir o modal começa do zero — nenhum resquício da tentativa anterior.
  useEffect(() => {
    if (open) return;
    setAccepted(false);
    setStarted(false);
    setReachedPairing(false);
    setConnectError(null);
    previousStatus.current = null;
  }, [open]);

  const canConnect = alreadyAccepted || accepted;
  const qrUnavailable = isApiError(qr.error) && qr.error.code === 'CHANNEL_QR_UNAVAILABLE';
  const expired = started && reachedPairing && qrData?.status === 'disconnected';

  /**
   * O polling só liga DEPOIS que `POST /connect` respondeu — nunca junto com o
   * clique.
   *
   * `GET /qr` deixou de chamar `/instance/connect` (auditoria de 2026-09-17:
   * aquela rota não é leitura, cada chamada abre uma conexão Baileys nova e o
   * polling de 2s derrubava a sessão). Hoje ela lê `connectionState` + o QR que
   * `POST /connect` semeia no cache, e responde `disconnected` quando não acha
   * QR — o sinal legítimo de "pareamento morto", que faz o polling parar.
   *
   * Ligar o polling no clique corria com o `POST /connect`: o primeiro `GET
   * /qr` chegava antes de existir instância ou cache, respondia `disconnected`,
   * e `qrRefetchInterval` encerrava o polling na primeira tentativa — modal
   * preso em "Gerando QR code..." para sempre. Esperar o `onSuccess` é o que
   * torna verdadeira a premissa de `getWhatsAppQr`: quando ele roda, o cache já
   * nasceu populado.
   */
  const handleConnect = () => {
    setConnectError(null);
    setReachedPairing(false);
    setStarted(false);
    connect.mutate(
      { acceptTerms: true },
      {
        onSuccess: () => setStarted(true),
        onError: (error) => setConnectError(connectErrorMessage(error)),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Conectar WhatsApp por QR">
      <div className="flex flex-col gap-lg">
        <div className="flex flex-col gap-sm rounded-md border border-neutral-300 bg-neutral-100 p-md">
          <p className="m-0 font-body text-body text-text">
            Este número passa a falar com o WhatsApp direto do celular do laboratório, sem a API
            oficial da Meta. Antes de conectar, entenda o risco:
          </p>
          <ul className="m-0 flex list-disc flex-col gap-xs pl-lg font-body text-caption text-neutral-700">
            <li>
              Há <strong>risco de banimento</strong> do número pelo WhatsApp — a política de uso
              não é a mesma da API oficial da Meta.
            </li>
            <li>Usar fora dos Termos de Serviço do WhatsApp é responsabilidade do laboratório.</li>
            <li>Use um número dedicado ao laboratório — nunca o número pessoal de alguém da equipe.</li>
            <li>
              O celular pareado precisa abrir o WhatsApp a cada ~14 dias, ou a sessão cai
              sozinha.
            </li>
            <li>
              As mensagens do paciente podem trazer dado de saúde e passam pelo gateway do CRM
              antes de chegar aqui.
            </li>
          </ul>

          {!alreadyAccepted && (
            <label className="flex cursor-pointer items-start gap-sm font-body text-caption text-text">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>Aceito o risco e as condições descritas acima.</span>
            </label>
          )}
        </div>

        {!started && (
          <Button
            variant="primary"
            disabled={!canConnect}
            loading={connect.isPending}
            onClick={handleConnect}
          >
            Conectar
          </Button>
        )}

        {connectError && (
          <p role="alert" className="m-0 font-body text-caption text-accent-700">
            {connectError}
          </p>
        )}

        {started && qrUnavailable && (
          <p role="alert" className="m-0 font-body text-caption text-accent-700">
            {GATEWAY_UNAVAILABLE_MESSAGE}
          </p>
        )}

        {started && !qrUnavailable && qrData?.status === 'pairing' && qrData.qrcode && (
          <div className="flex flex-col items-center gap-sm">
            <img
              src={qrData.qrcode}
              alt="QR Code do WhatsApp"
              className="h-[220px] w-[220px] rounded-md border border-neutral-300"
            />
            {qrData.expiresInSeconds !== null && (
              <span className="font-body text-caption text-neutral-600">
                Expira em {qrData.expiresInSeconds}s — abra o WhatsApp no celular e escaneie.
              </span>
            )}
          </div>
        )}

        {(connect.isPending || started) &&
          !qrUnavailable &&
          !connectError &&
          !expired &&
          (!qrData || (qrData.status !== 'pairing' && qrData.status !== 'connected')) && (
            <p role="status" className="m-0 font-body text-caption text-neutral-600">
              Gerando QR code...
            </p>
          )}

        {expired && (
          <div className="flex flex-col items-start gap-sm">
            <p className="m-0 font-body text-caption text-accent-700">
              O QR expirou antes de parear. Gere um novo para tentar de novo.
            </p>
            <Button variant="secondary" loading={connect.isPending} onClick={handleConnect}>
              Gerar novamente
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default WhatsAppConnectModal;
