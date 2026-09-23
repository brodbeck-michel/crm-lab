import {
  MessageSquare,
  Users,
  KanbanSquare,
  ClipboardList,
  BarChart3,
  MessagesSquare,
  Zap,
  ListChecks,
  FileBarChart2,
  ClipboardCheck,
  Search,
  ShoppingBag,
  Radio,
  SlidersVertical,
  ShieldCheck,
  UserCog,
  Percent,
  KeyRound,
  Palette,
  Building2,
  Receipt,
  CircleUserRound,
  Megaphone,
  type LucideIcon,
} from 'lucide-react';
import type { NavIcon } from '@/routes/route-config';

/**
 * Ícones do trilho — lucide-react (CRMLAB-44), 19px / stroke 1.7, herdando
 * `currentColor` do item (sem cor literal aqui).
 */
const ICONS: Record<NavIcon, LucideIcon> = {
  inbox: MessageSquare,
  patients: Users,
  pipeline: KanbanSquare,
  catalog: ClipboardList,
  analytics: BarChart3,
  chat: MessagesSquare,
  'quick-replies': Zap,
  decisions: ListChecks,
  results: FileBarChart2,
  reconciliation: ClipboardCheck,
  'active-search': Search,
  sales: ShoppingBag,
  channels: Radio,
  operation: SlidersVertical,
  insurances: ShieldCheck,
  attendants: UserCog,
  commissions: Percent,
  users: KeyRound,
  theme: Palette,
  tenants: Building2,
  billing: Receipt,
  account: CircleUserRound,
  megaphone: Megaphone,
};

export interface NavGlyphProps {
  name: NavIcon;
  size?: number;
}

export function NavGlyph({ name, size = 19 }: NavGlyphProps) {
  const Icon = ICONS[name];
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" focusable="false" />;
}
