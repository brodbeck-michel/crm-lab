import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import {
  DOCTOR_TIMELINE_COMMENT_MAX_LENGTH,
  DOCTOR_TIMELINE_FILTERS,
  DOCTOR_TIMELINE_FILTER_LABELS,
  VISIT_TYPE_LABELS,
  doctorTimelineCommentPermissions,
  isVisitRecordEditable,
  visitDurationMinutes,
  type DoctorTimelineComment,
  type DoctorTimelineFilter,
  type DoctorTimelineItem,
  type DoctorTimelineVisit,
  type UpdateVisitReportRequest,
  type VisitAttachment,
  type VisitReport,
} from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { visitsApi } from '@/api/visits';
import { isApiError } from '@/api/client';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore } from '@/stores/auth.store';
import { Button, TextArea, cn, useToast } from '@/components/ui';
import { formatMinutes } from '@/lib/format';
import { formatDateTime, formatTime } from './agenda-dates';
import { PersonAvatar, PurposeDot, StatusBadge } from './agenda-ui';
import { openVisitAttachment } from './VisitRecord';

/**
 * Feed da ficha do médico — CRMLAB-192 (D-332), PAGES.md §22b. A visita
 * completa (relato com "Ver mais", check-in/out, anexos e edição do relato),
 * os comentários de cada item e o filtro por tipo. A página e a paginação
 * ficam em `DoctorProfile.tsx`.
 */

/** "Tudo" ou um tipo — o filtro da tela é de escolha única. */
export type FeedFilterValue = 'tudo' | DoctorTimelineFilter;

export function FeedFilter({ value, onChange }: { value: FeedFilterValue; onChange: (value: FeedFilterValue) => void }) {
  const options: Array<{ value: FeedFilterValue; label: string }> = [
    { value: 'tudo', label: 'Tudo' },
    ...DOCTOR_TIMELINE_FILTERS.map((filter) => ({ value: filter, label: DOCTOR_TIMELINE_FILTER_LABELS[filter] })),
  ];
  return (
    <div role="radiogroup" aria-label="Filtrar por tipo" className="flex flex-wrap gap-xs">
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-pill border px-md py-xs font-body text-caption font-semibold transition-colors',
              checked
                ? 'border-accent bg-accent-100 text-accent-700'
                : 'border-neutral-300 bg-surface text-neutral-700 hover:bg-neutral-100',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Campo do relato cortado em N linhas (D-332 item 2). */
export const REPORT_CLAMP_LINES = 4;
/** Caracteres por linha da estimativa — determinística, sem medir layout. */
const CHARS_PER_LINE = 90;

export function estimateLines(text: string): number {
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

const REPORT_FIELDS: Array<{ key: keyof VisitReport; label: string }> = [
  { key: 'presented', label: 'O que foi apresentado' },
  { key: 'doctorFeedback', label: 'Feedback do médico' },
  { key: 'objections', label: 'Objeções' },
];

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

/** "Check-in às 13:20 de 06/10 · Check-out às 13:55 de 06/10 · 35 min" — só o que houver. */
export function checkLine(visit: Pick<DoctorTimelineVisit, 'checkInAt' | 'checkOutAt'>): string | null {
  const parts: string[] = [];
  if (visit.checkInAt) parts.push(`Check-in às ${formatTime(visit.checkInAt)} de ${dayMonth.format(new Date(visit.checkInAt))}`);
  if (visit.checkOutAt) {
    parts.push(`Check-out às ${formatTime(visit.checkOutAt)} de ${dayMonth.format(new Date(visit.checkOutAt))}`);
  }
  const duration = visitDurationMinutes(visit);
  if (duration !== null) parts.push(formatMinutes(duration));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function invalidateFeed(queryClient: ReturnType<typeof useQueryClient>, doctorId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.doctorTimeline(doctorId) });
}

export function VisitFeedItem({ visit, doctorId }: { visit: DoctorTimelineVisit; doctorId: string }) {
  const [editing, setEditing] = useState(false);
  const check = checkLine(visit);
  const editable = isVisitRecordEditable(visit.status);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="flex min-w-0 items-center gap-sm">
          <PersonAvatar person={visit.responsible} size={32} />
          <div className="flex min-w-0 flex-col">
            <span className="font-heading text-label font-semibold text-text">
              {visit.responsible?.name ?? 'Sem responsável'}
            </span>
            <span className="text-caption tabular-nums text-neutral-600">{formatDateTime(visit.occurredAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <StatusBadge status={visit.status} />
          <Link
            to={`/visitation/agenda?visit=${visit.id}`}
            className="text-caption font-semibold text-accent-700 hover:underline"
          >
            Abrir visita
          </Link>
        </div>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-xs text-caption text-text">
        <PurposeDot color={visit.purpose.color} />
        <span className="font-semibold">{visit.purpose.name}</span>
        <span className="text-neutral-600">· {VISIT_TYPE_LABELS[visit.type]}</span>
      </p>
      {check && (
        <p className="m-0 text-caption tabular-nums text-neutral-700" data-testid="visit-check-line">
          {check}
        </p>
      )}
      {visit.statusReason && <p className="m-0 text-caption text-neutral-600">Motivo: {visit.statusReason}</p>}

      {editing ? (
        <ReportEditor visit={visit} doctorId={doctorId} onDone={() => setEditing(false)} />
      ) : (
        <>
          <ReportView report={visit.report} />
          {editable && (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Editar relato
              </Button>
            </div>
          )}
        </>
      )}

      {visit.attachments.length > 0 && <AttachmentStrip visitId={visit.id} attachments={visit.attachments} />}
    </>
  );
}

function ReportView({ report }: { report: VisitReport }) {
  const [expanded, setExpanded] = useState(false);
  const filled = REPORT_FIELDS.flatMap(({ key, label }) => {
    const value = report[key];
    return value ? [{ key, label, value }] : [];
  });
  if (filled.length === 0) return null;
  const long = filled.some(({ value }) => estimateLines(value) > REPORT_CLAMP_LINES);

  return (
    <div className="flex flex-col gap-xs" data-testid="visit-report-full">
      <dl className="m-0 flex flex-col gap-xs">
        {filled.map(({ key, label, value }) => (
          <div key={key}>
            <dt className="text-caption font-semibold text-neutral-700">{label}</dt>
            <dd
              className={cn(
                'm-0 whitespace-pre-wrap break-words font-body text-body text-text',
                long && !expanded && 'line-clamp-4',
              )}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {long && (
        <div>
          <button
            type="button"
            className="text-caption font-semibold text-accent-700 hover:underline"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? 'Ver menos' : 'Ver mais'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Mesma regra do servidor: vazio vira `null`. */
function cleanText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function ReportEditor({ visit, doctorId, onDone }: { visit: DoctorTimelineVisit; doctorId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const [presented, setPresented] = useState(visit.report.presented ?? '');
  const [doctorFeedback, setDoctorFeedback] = useState(visit.report.doctorFeedback ?? '');
  const [objections, setObjections] = useState(visit.report.objections ?? '');

  /** Só o que mudou — o servidor grava e audita o diff. */
  const pending: UpdateVisitReportRequest = {};
  const p = cleanText(presented);
  const f = cleanText(doctorFeedback);
  const o = cleanText(objections);
  if (p !== visit.report.presented) pending.presented = p;
  if (f !== visit.report.doctorFeedback) pending.doctorFeedback = f;
  if (o !== visit.report.objections) pending.objections = o;
  const dirty = Object.keys(pending).length > 0;

  const save = useMutation({
    mutationFn: (body: UpdateVisitReportRequest) => visitsApi.updateReport(visit.id, body),
    onSuccess: (updated) => {
      toast('Relato salvo', { tone: 'positive' });
      queryClient.setQueryData(queryKeys.visit(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
      invalidateFeed(queryClient, doctorId);
      onDone();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'VISIT_ALREADY_CLOSED') {
        toast('A visita já foi encerrada por outra pessoa.', { tone: 'attention' });
        invalidateFeed(queryClient, doctorId);
        onDone();
        return;
      }
      handleApiError(error);
    },
  });

  return (
    <div className="flex flex-col gap-sm" data-testid="visit-report-editor">
      <TextArea label="O que foi apresentado" value={presented} onChange={(e) => setPresented(e.target.value)} rows={2} />
      <TextArea
        label="Feedback do médico"
        value={doctorFeedback}
        onChange={(e) => setDoctorFeedback(e.target.value)}
        rows={2}
      />
      <TextArea label="Objeções" value={objections} onChange={(e) => setObjections(e.target.value)} rows={2} />
      <div className="flex justify-end gap-sm">
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => save.mutate(pending)}
          loading={save.isPending}
          disabled={!dirty}
        >
          Salvar relato
        </Button>
      </div>
    </div>
  );
}

function AttachmentStrip({ visitId, attachments }: { visitId: string; attachments: VisitAttachment[] }) {
  const { toast } = useToast();
  const [opening, setOpening] = useState<string | null>(null);

  async function open(attachment: VisitAttachment) {
    if (opening) return;
    setOpening(attachment.id);
    try {
      await openVisitAttachment(visitId, attachment);
    } catch {
      toast('Não foi possível baixar o anexo.', { tone: 'attention' });
    } finally {
      setOpening(null);
    }
  }

  return (
    <ul className="m-0 flex list-none flex-wrap gap-sm p-0" aria-label="Anexos">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <button
            type="button"
            onClick={() => void open(attachment)}
            disabled={opening === attachment.id}
            aria-label={`Abrir ${attachment.fileName}`}
            title={attachment.fileName}
            className="flex items-center gap-xs rounded-md border border-neutral-300 bg-surface p-xs hover:bg-neutral-100"
          >
            {attachment.mimeType.startsWith('image/') ? (
              <AttachmentThumb visitId={visitId} attachment={attachment} />
            ) : (
              <>
                <FileText aria-hidden="true" className="h-8 w-8 text-neutral-600" />
                <span className="max-w-40 truncate text-caption text-text">{attachment.fileName}</span>
              </>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Miniatura pelo download autenticado (não há rota de thumbnail). Falhou → ícone. */
function AttachmentThumb({ visitId, attachment }: { visitId: string; attachment: VisitAttachment }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    if (typeof URL.createObjectURL !== 'function') return undefined;
    visitsApi
      .downloadAttachment(visitId, attachment.id)
      .then(({ blob }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visitId, attachment.id]);

  if (!src) return <FileText aria-hidden="true" className="h-16 w-16 text-neutral-600" />;
  return <img src={src} alt={attachment.fileName} className="h-16 w-16 rounded-sm object-cover" />;
}

/* ------------------------------------------------------------------ */
/* Comentários (D-332 itens 3–7)                                       */
/* ------------------------------------------------------------------ */

export function FeedComments({ item, doctorId }: { item: DoctorTimelineItem; doctorId: string }) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const user = useAuthStore((s) => s.user);
  const [draft, setDraft] = useState('');

  const create = useMutation({
    mutationFn: (body: string) => doctorsApi.createComment(doctorId, { itemKind: item.kind, itemId: item.id, body }),
    onSuccess: () => {
      setDraft('');
      invalidateFeed(queryClient, doctorId);
    },
    onError: handleApiError,
  });

  const remove = useMutation({
    mutationFn: (commentId: string) => doctorsApi.deleteComment(doctorId, commentId),
    onSuccess: () => {
      toast('Comentário excluído', { tone: 'positive' });
      invalidateFeed(queryClient, doctorId);
    },
    onError: handleApiError,
  });

  const body = draft.trim();
  return (
    <div className="flex flex-col gap-xs border-t border-neutral-200 pt-sm" data-testid="feed-comments">
      {item.comments.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Comentários">
          {item.comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              doctorId={doctorId}
              permissions={
                user ? doctorTimelineCommentPermissions(comment, user) : { canEdit: false, canDelete: false }
              }
              onDelete={() => {
                if (!window.confirm('Excluir este comentário? Não dá para desfazer.')) return;
                remove.mutate(comment.id);
              }}
              deleting={remove.isPending && remove.variables === comment.id}
            />
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-xs md:flex-row md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.length > 0) create.mutate(body);
        }}
      >
        <TextArea
          aria-label="Escreva um comentário"
          placeholder="Escreva um comentário"
          value={draft}
          maxLength={DOCTOR_TIMELINE_COMMENT_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          rows={1}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={body.length === 0} loading={create.isPending}>
          Comentar
        </Button>
      </form>
    </div>
  );
}

interface CommentRowProps {
  comment: DoctorTimelineComment;
  doctorId: string;
  permissions: { canEdit: boolean; canDelete: boolean };
  onDelete: () => void;
  deleting: boolean;
}

function CommentRow({ comment, doctorId, permissions, onDelete, deleting }: CommentRowProps) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const author = comment.author?.name ?? 'Usuário removido';

  const update = useMutation({
    mutationFn: (body: string) => doctorsApi.updateComment(doctorId, comment.id, { body }),
    onSuccess: () => {
      setEditing(false);
      invalidateFeed(queryClient, doctorId);
    },
    onError: handleApiError,
  });

  return (
    <li className="flex flex-col gap-xs rounded-md bg-surface px-sm py-xs">
      <div className="flex flex-wrap items-center justify-between gap-xs">
        <span className="text-caption text-neutral-600">
          <span className="font-semibold text-text">{author}</span> · {formatDateTime(comment.createdAt)}
          {comment.editedAt ? ' · (editado)' : ''}
        </span>
        {!editing && (permissions.canEdit || permissions.canDelete) && (
          <span className="flex gap-xs">
            {permissions.canEdit && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setText(comment.body);
                  setEditing(true);
                }}
                aria-label={`Editar comentário de ${author}`}
              >
                Editar
              </Button>
            )}
            {permissions.canDelete && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onDelete}
                loading={deleting}
                aria-label={`Excluir comentário de ${author}`}
              >
                Excluir
              </Button>
            )}
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-xs">
          <TextArea
            aria-label="Editar comentário"
            value={text}
            maxLength={DOCTOR_TIMELINE_COMMENT_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <div className="flex justify-end gap-xs">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={text.trim().length === 0}
              loading={update.isPending}
              onClick={() => update.mutate(text.trim())}
            >
              Salvar
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 whitespace-pre-wrap break-words font-body text-body text-text">{comment.body}</p>
      )}
    </li>
  );
}
