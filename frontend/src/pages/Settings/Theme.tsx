import { useEffect, useState } from 'react';
import { useThemeCurrent, useThemePresets, useUpdateTheme } from '@/api/themes';
import ColorPicker from '@/components/theme/ColorPicker';
import ThemePreview from '@/components/theme/ThemePreview';
import { Button, Input, SegmentedControl } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { FontId, RadiusId, ThemePreset } from '@crm-lab/shared';

const FONT_OPTIONS: Array<SegmentedOption<FontId>> = [
  { value: 'playfair', label: 'Playfair' },
  { value: 'figtree', label: 'Figtree' },
  { value: 'system', label: 'Sistema' },
];

const RADIUS_OPTIONS: Array<SegmentedOption<RadiusId>> = [
  { value: 'reto', label: 'Reto' },
  { value: 'suave', label: 'Suave' },
  { value: 'redondo', label: 'Redondo' },
];

const CARD = 'flex flex-col gap-md rounded-md border border-neutral-200 bg-neutral-100 p-lg shadow-sm';

/**
 * Personalização (`/settings/theme`) — PAGES.md §9, D-250.
 *
 * O cliente escolhe SÓ: cor principal (accent), cor secundária (accent2),
 * fonte, cantos, nome exibido e logo. Fundo, superfície e cor do texto são
 * fixos no app (fundo branco, texto escuro) — por isso não aparecem aqui, e
 * aplicar um preset envia só accent + accent2.
 */
export default function ThemeSettings() {
  const { data: currentTheme, isLoading } = useThemeCurrent();
  const { data: presets = [] } = useThemePresets();
  const updateTheme = useUpdateTheme();

  const [brandName, setBrandName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

  useEffect(() => {
    setBrandName(currentTheme?.brandName ?? '');
    setLogoUrl(currentTheme?.logoUrl ?? '');
  }, [currentTheme?.brandName, currentTheme?.logoUrl]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Carregando...</div>;
  }

  if (!currentTheme) {
    return <div className="flex items-center justify-center h-full">Erro ao carregar tema</div>;
  }

  const handleApplyPreset = (preset: ThemePreset) => {
    updateTheme.mutate({ accent: preset.accent, accent2: preset.accent2 });
  };

  const identityChanged =
    brandName.trim() !== (currentTheme.brandName ?? '') ||
    logoUrl.trim() !== (currentTheme.logoUrl ?? '');

  const handleSaveIdentity = () => {
    updateTheme.mutate({
      brandName: brandName.trim() || null,
      logoUrl: logoUrl.trim() || null,
    });
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div>
        <h1 className="font-heading text-display">Personalização</h1>
        <p className="text-body text-neutral-600 mt-sm">
          Customize as cores do seu laboratório. O fundo das telas é sempre branco; a cor do tema
          aparece no menu, nos cartões, nas tabelas e nos botões.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-lg flex-1 overflow-auto">
        <div className="flex flex-col gap-lg">
          <div className={CARD}>
            <h3 className="font-heading text-section">Temas Predefinidos</h3>
            <div className="space-y-sm">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleApplyPreset(preset)}
                  disabled={updateTheme.isPending}
                  className="w-full flex items-center gap-md p-md border border-neutral-300 rounded-md bg-bg hover:bg-accent-100 transition-colors text-left"
                >
                  <span className="flex flex-shrink-0 gap-xs" aria-hidden="true">
                    <span
                      className="w-6 h-6 rounded-md border border-neutral-300"
                      style={{ backgroundColor: preset.accent }}
                    />
                    <span
                      className="w-6 h-6 rounded-md border border-neutral-300"
                      style={{ backgroundColor: preset.accent2 }}
                    />
                  </span>
                  <span>
                    <span className="block text-label font-semibold">{preset.name}</span>
                    <span className="block text-caption text-neutral-600">
                      {preset.accent} · {preset.accent2}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={CARD}>
            <h3 className="font-heading text-section">Cor Personalizada</h3>
            <ColorPicker
              label="Cor principal"
              color={currentTheme.accent}
              onChange={(accent) => updateTheme.mutate({ accent })}
              isPending={updateTheme.isPending}
            />
            <ColorPicker
              label="Cor secundária"
              color={currentTheme.accent2}
              onChange={(accent2) => updateTheme.mutate({ accent2 })}
              isPending={updateTheme.isPending}
            />
          </div>

          <div className={CARD}>
            <h3 className="font-heading text-section">Fonte e Cantos</h3>
            <div className="flex flex-col gap-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">Fonte</span>
              <SegmentedControl
                aria-label="Fonte"
                options={FONT_OPTIONS}
                value={currentTheme.fontId}
                onChange={(fontId) => updateTheme.mutate({ fontId })}
              />
            </div>
            <div className="flex flex-col gap-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">Cantos</span>
              <SegmentedControl
                aria-label="Cantos"
                options={RADIUS_OPTIONS}
                value={currentTheme.radiusId}
                onChange={(radiusId) => updateTheme.mutate({ radiusId })}
              />
            </div>
          </div>

          <div className={CARD}>
            <h3 className="font-heading text-section">Nome e Logo</h3>
            <Input
              label="Nome exibido"
              value={brandName}
              maxLength={255}
              placeholder="Nome do laboratório"
              onChange={(e) => setBrandName(e.target.value)}
            />
            <Input
              label="Endereço do logo (URL)"
              value={logoUrl}
              maxLength={500}
              placeholder="https://..."
              hint="Usado nos relatórios em PDF."
              onChange={(e) => setLogoUrl(e.target.value)}
            />
            <div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveIdentity}
                disabled={!identityChanged || updateTheme.isPending}
              >
                Salvar nome e logo
              </Button>
            </div>
          </div>
        </div>

        <div className={`${CARD} self-start`}>
          <h3 className="font-heading text-section">Preview</h3>
          <ThemePreview theme={currentTheme} />
        </div>
      </div>
    </div>
  );
}
