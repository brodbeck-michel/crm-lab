import { useThemeCurrent, useThemePresets, useUpdateTheme } from '@/api/themes';
import ColorPicker from '@/components/theme/ColorPicker';
import ThemePreview from '@/components/theme/ThemePreview';
import type { Theme } from '@crm-lab/shared';

export default function ThemeSettings() {
  const { data: currentTheme, isLoading } = useThemeCurrent();
  const { data: presets = [] } = useThemePresets();
  const updateTheme = useUpdateTheme();

  if (isLoading) {
    return <div className="flex items-center justify-center h-full">Carregando...</div>;
  }

  if (!currentTheme) {
    return <div className="flex items-center justify-center h-full">Erro ao carregar tema</div>;
  }

  const handleApplyPreset = (preset: Partial<Theme>) => {
    updateTheme.mutate({
      accent: preset.accent,
      accent2: preset.accent2,
      bg: preset.bg,
      surface: preset.surface,
      text: preset.text,
    });
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div>
        <h1 className="text-heading-32">Personalização</h1>
        <p className="text-body-md text-neutral-600 mt-sm">
          Customize as cores do seu laboratório
        </p>
      </div>

      <div className="grid grid-cols-2 gap-lg flex-1 overflow-auto">
        {/* Left column: Presets and color picker */}
        <div className="flex flex-col gap-lg">
          {/* Presets */}
          <div className="bg-white rounded-md p-lg shadow-sm border border-neutral-200">
            <h3 className="text-heading-16 font-semibold mb-md">Temas Predefinidos</h3>
            <div className="space-y-sm">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handleApplyPreset(preset)}
                  className="w-full flex items-center gap-md p-md border border-neutral-200 rounded-md hover:bg-neutral-50 transition-colors text-left"
                >
                  <div
                    className="w-6 h-6 rounded-md flex-shrink-0 border border-neutral-300"
                    style={{ backgroundColor: preset.accent }}
                  />
                  <div>
                    <p className="text-sm font-medium">{preset.name}</p>
                    <p className="text-xs text-neutral-500">{preset.accent}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Custom color picker */}
          <div className="bg-white rounded-md p-lg shadow-sm border border-neutral-200">
            <h3 className="text-heading-16 font-semibold mb-md">Cor Personalizada</h3>
            <ColorPicker
              color={currentTheme.accent}
              onChange={(accent) => updateTheme.mutate({ accent })}
              isPending={updateTheme.isPending}
            />
          </div>
        </div>

        {/* Right column: Preview */}
        <div className="bg-white rounded-md p-lg shadow-sm border border-neutral-200">
          <h3 className="text-heading-16 font-semibold mb-md">Preview</h3>
          <ThemePreview theme={currentTheme} />
        </div>
      </div>
    </div>
  );
}
