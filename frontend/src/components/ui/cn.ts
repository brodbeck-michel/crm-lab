/** Junta classes condicionais. Valores falsos são descartados. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
