import { useEffect, useState } from 'react';
import { Input } from '@/components/ui';

interface ColorPickerProps {
  /** Nome da cor ("Cor principal", "Cor secundária") — rotula os dois campos. */
  label: string;
  color: string;
  onChange: (color: string) => void;
  isPending?: boolean;
}

const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * Seletor de UMA cor do tema: o seletor nativo + o campo hex `#rrggbb`.
 * Só chama `onChange` com hex completo e válido — o backend valida o mesmo
 * formato (SERVICES.md §8).
 */
export default function ColorPicker({ label, color, onChange, isPending }: ColorPickerProps) {
  const [localColor, setLocalColor] = useState(color);

  useEffect(() => {
    setLocalColor(color);
  }, [color]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setLocalColor(newColor);
    if (HEX_PATTERN.test(newColor)) onChange(newColor);
  };

  return (
    <div className="flex flex-col gap-sm">
      <span className="font-body text-label font-semibold text-text">{label}</span>
      <div className="flex items-end gap-md">
        <div className="w-24 flex-shrink-0">
          <Input
            type="color"
            aria-label={label}
            value={HEX_PATTERN.test(localColor) ? localColor : color}
            onChange={handleChange}
            disabled={isPending}
          />
        </div>
        <div className="flex-1">
          <Input
            type="text"
            value={localColor}
            onChange={handleChange}
            placeholder="#rrggbb"
            disabled={isPending}
            label={`${label} (hex)`}
            hint="Formato: #rrggbb (6 dígitos hexadecimais)"
          />
        </div>
      </div>
    </div>
  );
}
