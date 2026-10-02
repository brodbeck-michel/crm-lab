import { Button, Chip, Input } from '@/components/ui';
import type { Theme } from '@crm-lab/shared';

interface ThemePreviewProps {
  theme: Theme;
}

const FONT_LABELS: Record<Theme['fontId'], string> = {
  playfair: 'Playfair + Figtree',
  figtree: 'Figtree',
  system: 'Fonte do sistema',
};

const RADIUS_LABELS: Record<Theme['radiusId'], string> = {
  reto: 'Reto',
  suave: 'Suave',
  redondo: 'Redondo',
};

/**
 * Prévia do tema (D-250): uma tela em miniatura com o visual real —
 * página BRANCA, menu no tom claro do accent com item ativo branco, cartão
 * com tabela tingida, campo de busca branco, botões e chips de status.
 *
 * Tudo aqui lê os tokens CSS (que `applyTheme` já trocou ao salvar), então a
 * prévia é exatamente o que o resto do app mostra. Do objeto `theme` só saem
 * os textos: os hex das 2 cores, nome, fonte e cantos.
 */
export default function ThemePreview({ theme }: ThemePreviewProps) {
  const brand = theme.brandName || 'Seu laboratório';

  return (
    <div className="flex flex-col gap-lg">
      {/* Paleta: só as 2 cores que o cliente escolhe */}
      <div className="grid grid-cols-2 gap-sm">
        {(
          [
            { hex: theme.accent, label: 'Cor principal', swatch: 'bg-accent' },
            { hex: theme.accent2, label: 'Cor secundária', swatch: 'bg-accent2' },
          ] as const
        ).map((color) => (
          <div key={color.label} className="flex items-center gap-sm">
            <span
              aria-hidden="true"
              className={`h-8 w-8 flex-shrink-0 rounded-md border border-neutral-300 ${color.swatch}`}
            />
            <span className="flex flex-col">
              <span className="font-body text-caption text-neutral-600">{color.label}</span>
              <span className="font-mono text-caption text-neutral-800">{color.hex}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Tela em miniatura: página branca + menu tingido + cartão com tabela */}
      <div
        data-testid="theme-preview-screen"
        className="flex gap-md rounded-lg border border-neutral-200 bg-bg p-md"
      >
        <div className="flex w-32 flex-shrink-0 flex-col gap-xs rounded-lg bg-surface p-sm shadow-sm">
          <div className="flex items-center gap-xs px-xs pb-xs">
            <span aria-hidden="true" className="h-6 w-6 flex-shrink-0 rounded-sm bg-accent-300" />
            <span className="min-w-0 truncate font-heading text-label text-text">{brand}</span>
          </div>
          <span className="rounded-md bg-bg px-sm py-xs font-body text-caption font-semibold text-accent-700 shadow-sm">
            Pacientes
          </span>
          <span className="rounded-md bg-accent-100 px-sm py-xs font-body text-caption text-text">
            Propostas
          </span>
          <span className="rounded-md px-sm py-xs font-body text-caption text-text">Vendas</span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-sm">
          <Input type="search" aria-label="Busca de exemplo" placeholder="Buscar paciente" readOnly />
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100">
            <div className="flex justify-between border-b border-neutral-300 bg-surface px-sm py-xs font-body text-micro font-semibold uppercase text-neutral-600">
              <span>Paciente</span>
              <span>Status</span>
            </div>
            <div className="flex items-center justify-between border-b border-neutral-200 px-sm py-xs font-body text-caption text-text">
              <span>Ana Souza</span>
              <Chip tone="positive">Ativo</Chip>
            </div>
            <div className="flex items-center justify-between border-b border-neutral-200 bg-accent-100 px-sm py-xs font-body text-caption text-text">
              <span>Bruno Lima</span>
              <Chip tone="attention">Atenção</Chip>
            </div>
            <div className="flex items-center justify-between px-sm py-xs font-body text-caption text-text">
              <span>Carla Dias</span>
              <Chip tone="inactive">Inativo</Chip>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            <Button variant="primary" size="sm">
              Primário
            </Button>
            <Button variant="secondary" size="sm">
              Secundário
            </Button>
            <a href="#preview" onClick={(event) => event.preventDefault()} className="font-body text-caption">
              Link
            </a>
          </div>
        </div>
      </div>

      <div className="flex gap-lg font-body text-caption text-neutral-600">
        <span>Fonte: {FONT_LABELS[theme.fontId]}</span>
        <span>Cantos: {RADIUS_LABELS[theme.radiusId]}</span>
      </div>
    </div>
  );
}
