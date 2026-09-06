import type { NavIcon } from '@/routes/route-config';

/**
 * Ícones do trilho — SVG inline com `currentColor`, sem dependência externa
 * e sem nenhuma cor literal (a cor vem do item da Sidebar, que usa tokens).
 */

const PATHS: Record<NavIcon, string> = {
  inbox: 'M3 5h18v10H8l-5 4V5z',
  pipeline: 'M4 4h4v16H4zM10 4h4v11h-4zM16 4h4v7h-4z',
  catalog: 'M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  chat: 'M4 4h16v11H9l-5 4V4z',
  'quick-replies': 'M4 5h16v10H9l-5 4V5zM8 10h6M8 7.5h8',
  decisions: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12l3 3 5-6',
  channels: 'M4 7h16M4 12h16M4 17h10',
  operation: 'M12 3v4M12 17v4M3 12h4M17 12h4M7 7l3 3M17 17l-3-3M7 17l3-3M17 7l-3 3',
  insurances: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4zM9 12l2 2 4-4',
  users: 'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 100-6M16 15c3 0 6 2 6 5',
  theme: 'M12 3a9 9 0 100 18h2a3 3 0 003-3 3 3 0 013-3 3 3 0 003-3 9 9 0 00-11-9z',
  tenants: 'M4 20V8l7-4 7 4v12M9 20v-5h6v5M4 20h16',
  billing: 'M3 7h18v11H3zM3 11h18M7 15h4',
};

export interface NavGlyphProps {
  name: NavIcon;
  size?: number;
}

export function NavGlyph({ name, size = 18 }: NavGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
