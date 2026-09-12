import type { NavIcon } from '@/routes/route-config';

/**
 * Ícones do trilho — SVG inline com `currentColor`, sem dependência externa
 * e sem nenhuma cor literal (a cor vem do item da Sidebar, que usa tokens).
 */

const PATHS: Record<NavIcon, string> = {
  inbox: 'M3 5h18v10H8l-5 4V5z',
  patients: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20c0-3.5 2.5-6 6-6s6 2.5 6 6M16 8a3 3 0 100-6M14 12c2.5 0 5 1.5 6 4',
  pipeline: 'M4 4h4v16H4zM10 4h4v11h-4zM16 4h4v7h-4z',
  catalog: 'M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  chat: 'M4 4h16v11H9l-5 4V4z',
  'quick-replies': 'M4 5h16v10H9l-5 4V5zM8 10h6M8 7.5h8',
  decisions: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12l3 3 5-6',
  results: 'M4 20V13M10 20V8M16 20v-5M4 20h16M14 4l4 0 0 4M18 4l-6 6',
  reconciliation: 'M4 4h16v16H4zM8 4v16M8 9h12M8 14h12',
  'active-search': 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5M11 8v3l2 2',
  sales: 'M4 8h16l-1.5 10a2 2 0 01-2 2h-9a2 2 0 01-2-2L4 8zM8 8V6a4 4 0 018 0v2',
  channels: 'M4 7h16M4 12h16M4 17h10',
  operation: 'M12 3v4M12 17v4M3 12h4M17 12h4M7 7l3 3M17 17l-3-3M7 17l3-3M17 7l-3 3',
  insurances: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4zM9 12l2 2 4-4',
  attendants: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.5 2.5-6 6-6s6 2.5 6 6M16 8a2.5 2.5 0 100-5M14 12c2.2 0 4.5 1.3 5.4 3.6',
  commissions: 'M12 3v18M8 7.5h5.5a2.5 2.5 0 010 5H9a2.5 2.5 0 000 5h6',
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
