import { Button, Chip } from '@/components/ui';
import type { Theme } from '@crm-lab/shared';

interface ThemePreviewProps {
  theme: Theme;
}

/**
 * Componente que mostra uma prévia de componentes com o tema selecionado.
 * Demonstra como os principais elementos visuais aparecerão.
 */
export default function ThemePreview({ theme }: ThemePreviewProps) {
  return (
    <div
      className="p-lg rounded-md space-y-lg"
      style={{
        backgroundColor: theme.bg,
      }}
    >
      <div className="space-y-sm">
        <h4 className="text-sm font-medium" style={{ color: theme.text }}>
          Paleta de Cores
        </h4>
        <div className="grid grid-cols-2 gap-sm">
          <div className="flex flex-col gap-xs">
            <div
              className="h-12 rounded-md border border-neutral-300"
              style={{ backgroundColor: theme.accent }}
            />
            <p className="text-xs font-mono text-neutral-700">{theme.accent}</p>
            <p className="text-xs text-neutral-600">Cor de Ação</p>
          </div>
          <div className="flex flex-col gap-xs">
            <div
              className="h-12 rounded-md border border-neutral-300"
              style={{ backgroundColor: theme.accent2 }}
            />
            <p className="text-xs font-mono text-neutral-700">{theme.accent2}</p>
            <p className="text-xs text-neutral-600">Cor Positiva</p>
          </div>
        </div>
      </div>

      <div className="space-y-sm pt-lg border-t border-neutral-300">
        <h4 className="text-sm font-medium" style={{ color: theme.text }}>
          Componentes
        </h4>

        <div className="space-y-sm">
          <div style={{ color: theme.text }}>
            <p className="text-sm font-medium mb-xs">Botões</p>
            <div className="flex gap-sm">
              <Button
                variant="primary"
                size="sm"
              >
                Primário
              </Button>
              <Button
                variant="secondary"
                size="sm"
              >
                Secundário
              </Button>
            </div>
          </div>

          <div style={{ color: theme.text }}>
            <p className="text-sm font-medium mb-xs">Indicadores</p>
            <div className="flex gap-sm flex-wrap">
              <Chip tone="positive">Positivo</Chip>
              <Chip tone="attention">Atenção</Chip>
              <Chip tone="inactive">Inativo</Chip>
            </div>
          </div>

          <div
            className="p-md rounded-md"
            style={{
              backgroundColor: theme.surface,
              color: theme.text,
            }}
          >
            <p className="text-sm font-medium">Superfície</p>
            <p className="text-xs opacity-75 mt-xs">Exemplo de cor de superfície</p>
          </div>
        </div>
      </div>

      <div className="text-xs text-neutral-600 pt-lg border-t border-neutral-300">
        <p>Font: {theme.fontId}</p>
        <p>Radius: {theme.radiusId}</p>
      </div>
    </div>
  );
}
