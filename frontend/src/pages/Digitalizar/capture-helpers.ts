import { MAX_SCAN_BYTES } from '@crm-lab/shared';

/**
 * Peças da `/digitalizar` (PAGES.md §24, CRMLAB-184): redução da foto e
 * detecção de "instalada na tela de início". O formato do código está em
 * `@/lib/pairing-code`.
 */

/* ── Redução no aparelho ─────────────────────────────────────────────────── */

export const SCAN_MAX_SIDE = 2048;
export const SCAN_QUALITIES = [0.8, 0.6] as const;

/** Lado maior até `max`, mantendo a proporção. Nunca amplia. */
export function fitWithin(width: number, height: number, max = SCAN_MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * JPEG 0,8; acima de 5 MB tenta 0,6; ainda acima, `null` (avisa e não sobe).
 * `encode` é injetado: o teste não precisa de canvas.
 */
export async function encodeWithinLimit(
  encode: (quality: number) => Promise<Blob>,
  maxBytes = MAX_SCAN_BYTES,
): Promise<Blob | null> {
  for (const quality of SCAN_QUALITIES) {
    const blob = await encode(quality);
    if (blob.size <= maxBytes) return blob;
  }
  return null;
}

async function loadImage(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  // `createImageBitmap` já aplica a orientação do EXIF (`imageOrientation: 'from-image'`).
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  await image.decode();
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/**
 * Canvas → JPEG (HEIC nunca chega ao servidor). `null` = acima de 5 MB mesmo
 * com 0,6. Erro de decodificação propaga (quem chama avisa).
 */
export async function reduceScanImage(file: Blob): Promise<Blob | null> {
  const image = await loadImage(file);
  try {
    const size = fitWithin(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas indisponível');
    context.drawImage(image.source, 0, 0, size.width, size.height);
    return await encodeWithinLimit(
      (quality) =>
        new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error('falha ao gerar JPEG'))),
            'image/jpeg',
            quality,
          );
        }),
    );
  } finally {
    image.release();
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

/* ── Instalada? iOS? ─────────────────────────────────────────────────────── */

export function isStandalone(): boolean {
  const media =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return media || iosStandalone;
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS se apresenta como Mac; o toque denuncia.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
