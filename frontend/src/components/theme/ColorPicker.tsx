import { useEffect, useState } from 'react';
import { Input } from '@/components/ui';

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  isPending?: boolean;
}

export default function ColorPicker({ color, onChange, isPending }: ColorPickerProps) {
  const [localColor, setLocalColor] = useState(color);

  useEffect(() => {
    setLocalColor(color);
  }, [color]);

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setLocalColor(newColor);
    onChange(newColor);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;

    // Validate hex color (6 digits)
    if (hexPattern.test(newColor)) {
      setLocalColor(newColor);
      onChange(newColor);
    } else if (!newColor.startsWith('#')) {
      // Allow partial input while typing
      setLocalColor(newColor);
    } else {
      setLocalColor(newColor);
    }
  };

  return (
    <div className="space-y-md">
      <div className="flex items-center gap-md">
        <div className="flex-1">
          <Input
            type="color"
            value={localColor}
            onChange={handleColorChange}
            disabled={isPending}
          />
        </div>
        <div
          className="w-12 h-12 rounded-md border-2 border-neutral-300 flex-shrink-0"
          style={{ backgroundColor: localColor }}
        />
      </div>

      <div>
        <Input
          type="text"
          value={localColor}
          onChange={handleInputChange}
          placeholder="ex: rrggbb"
          disabled={isPending}
          label="Valor Hex"
        />
        <p className="text-caption text-neutral-600 mt-xs">
          Formato: rrggbb (6 dígitos hexadecimais)
        </p>
      </div>
    </div>
  );
}
