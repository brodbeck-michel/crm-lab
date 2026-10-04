import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isVisitAttachmentMimeType,
  isVisitRecordEditable,
  MAX_MEDIA_BYTES,
  visitDurationMinutes,
  VISIT_ATTACHMENTS_MAX,
  type UpdateVisitReportRequest,
  type Visit,
  type VisitDetail,
  type VisitType,
} from '@crm-lab/shared';
import { visitsApi } from '@/api/visits';
import { isApiError } from '@/api/client';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { formatBytes } from '@/components/conversation/attachment-draft';
import { Button, Input, TextArea, useToast } from '@/components/ui';
import { formatMinutes } from '@/lib/format';
import { formatDateTime, formatTime } from './agenda-dates';

/**
 * Registro da visita — check-in/out, relato, próximo passo e anexos
 * (PAGES.md §23 · API_CONTRACTS.md §14 · CRMLAB-88, D-258). Vive dentro do
 * modal "Visita" da Agenda; cada seção grava sozinha e devolve a visita
 * atualizada para o cache do detalhe.
 */

/** O que "Agendar retorno" leva para a visita nova. Nada é criado sozinho. */
export interface ReturnVisitPrefill {
  /** Com o nome: o médico pode não estar entre os 100 do seletor (ou ter sido inativado). */
  doctor: { id: string; name: string; isActive: boolean };
  responsibleId: string | null;
  type: VisitType;
  /** Data de retorno às 09:00, no fuso do navegador. */
  at: Date;
}

function useVisitCache() {
  const queryClient = useQueryClient();
  return {
    store(updated: VisitDetail) {
      queryClient.setQueryData(queryKeys.visit(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
    },
    refresh(id: string) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.visit(id) });
      void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
    },
  };
}

/** Erro de estado (outra pessoa mexeu antes): avisa e recarrega a visita. */
function useStateConflictHandler(visitId: string) {
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();
  const cache = useVisitCache();
  return (error: unknown) => {
    if (isApiError(error)) {
      const message =
        error.code === 'VISIT_ALREADY_CLOSED'
          ? 'A visita já foi encerrada por outra pessoa.'
          : error.code === 'VISIT_NOT_CHECKED_IN'
            ? 'Faça o check-in antes do check-out.'
            : null;
      if (message) {
        toast(message, { tone: 'attention' });
        cache.refresh(visitId);
        return;
      }
    }
    handleApiError(error);
  };
}

/** "Cheguei" → "Saí" com um toque; depois, os horários e a duração. */
/** "Cheguei" e "Saí" — também usados pelo painel lateral da Agenda (CRMLAB-92). */
export function useVisitCheck(visitId: string) {
  const { toast } = useToast();
  const cache = useVisitCache();
  const onError = useStateConflictHandler(visitId);

  const checkIn = useMutation({
    mutationFn: () => visitsApi.checkIn(visitId),
    onSuccess: (updated) => {
      toast('Check-in registrado', { tone: 'positive' });
      cache.store(updated);
    },
    onError,
  });
  const checkOut = useMutation({
    mutationFn: () => visitsApi.checkOut(visitId),
    onSuccess: (updated) => {
      toast('Visita realizada', { tone: 'positive' });
      cache.store(updated);
    },
    onError,
  });
  return { checkIn, checkOut };
}

export function VisitCheckSection({ visit }: { visit: VisitDetail }) {
  const { checkIn, checkOut } = useVisitCheck(visit.id);

  const open = visit.status === 'agendada';
  // Cancelada/não recebeu sem check-in: não há o que mostrar.
  if (!open && visit.checkInAt === null) return null;

  const duration = visitDurationMinutes(visit);
  return (
    <section
      className="flex flex-col gap-sm rounded-lg border border-neutral-200 bg-surface p-md"
      data-testid="visit-check"
    >
      <h3 className="font-heading text-label font-semibold text-text">Registro</h3>
      {open && visit.checkInAt === null && (
        <div className="flex flex-col md:flex-row">
          <Button variant="primary" onClick={() => checkIn.mutate()} loading={checkIn.isPending}>
            Cheguei
          </Button>
        </div>
      )}
      {open && visit.checkInAt !== null && (
        <div className="flex flex-col gap-sm md:flex-row md:items-center md:justify-between">
          <span className="text-body text-text">
            Em visita desde{' '}
            <span className="font-semibold tabular-nums">{formatTime(visit.checkInAt)}</span>
            {visit.checkInBy ? (
              <span className="text-neutral-600"> · {visit.checkInBy.name}</span>
            ) : null}
          </span>
          <Button
            variant="confirmation"
            onClick={() => checkOut.mutate()}
            loading={checkOut.isPending}
          >
            Saí
          </Button>
        </div>
      )}
      {!open && (
        <p className="text-body text-text" data-testid="visit-check-summary">
          {[
            visit.checkInAt ? `Check-in ${formatDateTime(visit.checkInAt)}` : null,
            visit.checkOutAt ? `Check-out ${formatTime(visit.checkOutAt)}` : null,
            duration !== null ? `Duração ${formatMinutes(duration)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

/** Mesma regra do servidor: vazio vira `null`. */
function cleanText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface VisitReportSectionProps {
  visit: VisitDetail;
  onScheduleReturn: (prefill: ReturnVisitPrefill) => void;
}

/** Relato (três textos) + data de retorno, com [Agendar retorno]. */
export function VisitReportSection({ visit, onScheduleReturn }: VisitReportSectionProps) {
  const { toast } = useToast();
  const cache = useVisitCache();
  const onError = useStateConflictHandler(visit.id);
  const editable = isVisitRecordEditable(visit.status);

  const [presented, setPresented] = useState(visit.report.presented ?? '');
  const [doctorFeedback, setDoctorFeedback] = useState(visit.report.doctorFeedback ?? '');
  const [objections, setObjections] = useState(visit.report.objections ?? '');
  const [nextVisitDate, setNextVisitDate] = useState(visit.nextVisitDate ?? '');

  /** Só os campos que mudaram — o servidor grava e audita o diff. */
  function changes(): UpdateVisitReportRequest {
    const body: UpdateVisitReportRequest = {};
    const p = cleanText(presented);
    const f = cleanText(doctorFeedback);
    const o = cleanText(objections);
    const d = nextVisitDate.length > 0 ? nextVisitDate : null;
    if (p !== visit.report.presented) body.presented = p;
    if (f !== visit.report.doctorFeedback) body.doctorFeedback = f;
    if (o !== visit.report.objections) body.objections = o;
    if (d !== visit.nextVisitDate) body.nextVisitDate = d;
    return body;
  }

  const save = useMutation({
    mutationFn: (body: UpdateVisitReportRequest) => visitsApi.updateReport(visit.id, body),
    onSuccess: (updated) => {
      toast('Relato salvo', { tone: 'positive' });
      cache.store(updated);
    },
    onError,
  });

  const hasReport =
    visit.report.presented !== null ||
    visit.report.doctorFeedback !== null ||
    visit.report.objections !== null ||
    visit.nextVisitDate !== null;

  if (!editable) {
    if (!hasReport) return null;
    return (
      <section className="flex flex-col gap-sm" data-testid="visit-report">
        <h3 className="font-heading text-label font-semibold text-text">Relato</h3>
        <dl className="grid grid-cols-1 gap-sm text-body">
          <ReadOnly label="O que foi apresentado" value={visit.report.presented} />
          <ReadOnly label="Feedback do médico" value={visit.report.doctorFeedback} />
          <ReadOnly label="Objeções" value={visit.report.objections} />
          <ReadOnly
            label="Data de retorno"
            value={visit.nextVisitDate ? formatIsoDate(visit.nextVisitDate) : null}
          />
        </dl>
      </section>
    );
  }

  const pending = changes();
  const dirty = Object.keys(pending).length > 0;
  return (
    <section className="flex flex-col gap-md" data-testid="visit-report">
      <h3 className="font-heading text-label font-semibold text-text">Relato</h3>
      <TextArea
        label="O que foi apresentado"
        value={presented}
        onChange={(e) => setPresented(e.target.value)}
        rows={2}
      />
      <TextArea
        label="Feedback do médico"
        value={doctorFeedback}
        onChange={(e) => setDoctorFeedback(e.target.value)}
        rows={2}
      />
      <TextArea
        label="Objeções"
        value={objections}
        onChange={(e) => setObjections(e.target.value)}
        rows={2}
      />
      <div className="flex flex-col gap-sm md:flex-row md:items-end">
        <div className="md:w-1/2">
          <Input
            label="Data de retorno"
            type="date"
            value={nextVisitDate}
            onChange={(e) => setNextVisitDate(e.target.value)}
            hint="Próximo passo: sugere a próxima visita."
          />
        </div>
        {visit.nextVisitDate && (
          <Button
            variant="secondary"
            onClick={() => onScheduleReturn(returnPrefill(visit, visit.nextVisitDate ?? ''))}
          >
            Agendar retorno
          </Button>
        )}
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => save.mutate(pending)}
          loading={save.isPending}
          disabled={!dirty}
        >
          Salvar relato
        </Button>
      </div>
    </section>
  );
}

/** Data de retorno `'YYYY-MM-DD'` às 09:00 locais, com médico, responsável e tipo desta visita. */
export function returnPrefill(visit: Visit, isoDate: string): ReturnVisitPrefill {
  const [year, month, day] = isoDate.split('-').map(Number);
  return {
    doctor: { id: visit.doctor.id, name: visit.doctor.name, isActive: visit.doctor.isActive },
    responsibleId: visit.responsible?.id ?? null,
    type: visit.type,
    at: new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 9, 0),
  };
}

/** `'2026-11-03'` → `03/11/2026` (sem passar por fuso). */
function formatIsoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function ReadOnly({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div>
      <dt className="text-caption font-semibold text-neutral-700">{label}</dt>
      <dd className="whitespace-pre-wrap text-text">{value}</dd>
    </div>
  );
}

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

/**
 * Anexos (imagem e PDF). A tela barra antes de enviar o tipo e o tamanho que
 * o servidor recusaria; o servidor confere de novo (e o conteúdo).
 */
export function VisitAttachmentsSection({ visit }: { visit: VisitDetail }) {
  const { toast } = useToast();
  const cache = useVisitCache();
  const onError = useStateConflictHandler(visit.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const editable = isVisitRecordEditable(visit.status);
  const full = visit.attachments.length >= VISIT_ATTACHMENTS_MAX;

  const upload = useMutation({
    mutationFn: async (file: File) =>
      visitsApi.addAttachment(visit.id, {
        fileName: file.name,
        mimeType: file.type,
        contentBase64: await readFileAsBase64(file),
      }),
    onSuccess: () => {
      toast('Anexo adicionado', { tone: 'positive' });
      cache.refresh(visit.id);
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) => visitsApi.deleteAttachment(visit.id, attachmentId),
    onSuccess: () => {
      toast('Anexo excluído', { tone: 'positive' });
      cache.refresh(visit.id);
    },
    onError,
  });

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!isVisitAttachmentMimeType(file.type)) {
      toast('Só imagem ou PDF.', { tone: 'attention' });
      return;
    }
    if (file.size === 0 || file.size > MAX_MEDIA_BYTES) {
      toast(`O arquivo passa de ${formatBytes(MAX_MEDIA_BYTES)}.`, { tone: 'attention' });
      return;
    }
    upload.mutate(file);
  }

  /** PDF abre em nova aba; imagem baixa com o nome original (como o DocumentCard). */
  async function open(attachmentId: string, fileName: string, mimeType: string) {
    if (downloading) return;
    setDownloading(attachmentId);
    try {
      const { blob, fileName: served } = await visitsApi.downloadAttachment(visit.id, attachmentId);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      if (mimeType === 'application/pdf') {
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      } else {
        anchor.download = served ?? fileName;
      }
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoga depois que o navegador já abriu/baixou; imediato quebra o download.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      toast('Não foi possível baixar o anexo.', { tone: 'attention' });
    } finally {
      setDownloading(null);
    }
  }

  if (!editable && visit.attachments.length === 0) return null;

  return (
    <section className="flex flex-col gap-sm" data-testid="visit-attachments">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <h3 className="font-heading text-label font-semibold text-text">Anexos</h3>
        {editable && !full && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInput.current?.click()}
              loading={upload.isPending}
            >
              Anexar arquivo
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              aria-label="Escolher arquivo para anexar"
              onChange={(event) => {
                handleFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </>
        )}
      </div>
      {visit.attachments.length === 0 ? (
        <p className="text-caption text-neutral-600">
          Nenhum anexo. Imagem ou PDF, até {formatBytes(MAX_MEDIA_BYTES)}.
        </p>
      ) : (
        <ul className="flex flex-col gap-xs">
          {visit.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-col gap-xs rounded-md border border-neutral-200 p-sm md:flex-row md:items-center md:justify-between"
            >
              <span className="min-w-0">
                <span className="block truncate text-body font-semibold text-text">
                  {attachment.fileName}
                </span>
                <span className="block text-caption text-neutral-600">
                  {[
                    formatBytes(attachment.byteSize),
                    attachment.uploadedBy?.name,
                    formatDateTime(attachment.createdAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="flex gap-xs">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void open(attachment.id, attachment.fileName, attachment.mimeType)}
                  loading={downloading === attachment.id}
                  aria-label={`Baixar ${attachment.fileName}`}
                >
                  Baixar
                </Button>
                {editable && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      if (!window.confirm(`Excluir o anexo "${attachment.fileName}"?`)) return;
                      remove.mutate(attachment.id);
                    }}
                    aria-label={`Excluir ${attachment.fileName}`}
                  >
                    Excluir
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editable && full && (
        <p className="text-caption text-neutral-600">
          Limite de {VISIT_ATTACHMENTS_MAX} anexos por visita.
        </p>
      )}
    </section>
  );
}
