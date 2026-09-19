import { useEffect, useState } from 'react';
import { fetchAuthenticatedBlob, resolveMediaUrl } from '@/api';

export interface UseAuthenticatedMediaResult {
  /** `object URL` do blob já carregado, ou `null` enquanto carrega/em erro. */
  objectUrl: string | null;
  /** Nome original do arquivo (`Content-Disposition`), para o download. */
  fileName: string | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Carrega uma mídia servida por endpoint AUTENTICADO (`GET /media/:id`) como
 * `object URL`, para usar em `<img src>`/`<audio src>`/`<a href>` — que nunca
 * mandam `Authorization` sozinhos (CRMLAB-15, CRMLAB-2).
 *
 * Devolve também o nome original do arquivo, que o `object URL` não carrega —
 * é ele que dá nome ao download da imagem (CRMLAB-26).
 *
 * `url: null` (ex. lightbox fechado) não busca nada. Cada troca de URL revoga
 * o object URL anterior — sem isso o blob fica preso na memória do browser
 * pelo resto da sessão.
 */
export function useAuthenticatedMedia(url: string | null): UseAuthenticatedMediaResult {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(url !== null);
  const [isError, setError] = useState(false);

  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      setFileName(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let currentObjectUrl: string | null = null;
    setLoading(true);
    setError(false);

    fetchAuthenticatedBlob(resolveMediaUrl(url))
      .then(({ blob, fileName: name }) => {
        if (cancelled) return;
        currentObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(currentObjectUrl);
        setFileName(name);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    };
  }, [url]);

  return { objectUrl, fileName, isLoading, isError };
}
