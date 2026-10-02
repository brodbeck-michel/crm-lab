import type { MessageLocation } from '@crm-lab/shared';

export interface LocationCardProps {
  location: MessageLocation;
}

/** Link do Google Maps no ponto exato (D-236 item 6). */
export function googleMapsUrl(location: Pick<MessageLocation, 'latitude' | 'longitude'>): string {
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}

/**
 * LocationCard — localização compartilhada (CRMLAB-70, D-236 item 6): nome,
 * endereço e "Abrir no mapa" em outra aba. Sem mapa estático: pediria liberar
 * um host externo em `img-src` na CSP (CRMLAB-32).
 */
export function LocationCard({ location }: LocationCardProps) {
  const title = location.name ?? location.address ?? 'Localização';
  const subtitle = location.name ? location.address : null;
  return (
    <div
      data-testid="location-card"
      className="flex min-w-0 flex-col gap-xs rounded-md border border-neutral-200 bg-surface px-sm py-xs font-body"
    >
      <span className="flex min-w-0 items-baseline gap-xs">
        <span aria-hidden="true">📍</span>
        <span className="min-w-0 break-words text-label font-semibold text-text">{title}</span>
      </span>
      {subtitle && <span className="break-words text-caption text-neutral-700">{subtitle}</span>}
      <a
        href={googleMapsUrl(location)}
        target="_blank"
        rel="noreferrer"
        className="self-start text-caption font-semibold text-accent-700 underline"
      >
        Abrir no mapa
      </a>
    </div>
  );
}
