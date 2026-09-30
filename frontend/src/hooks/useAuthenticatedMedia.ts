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

interface LoadedMedia {
  objectUrl: string;
  fileName: string | null;
}

/**
 * Blob compartilhado por URL (D-245). `refs` = quantos componentes estão
 * usando agora; quando chega a zero o object URL é revogado e a entrada sai.
 */
interface MediaEntry {
  refs: number;
  loaded: LoadedMedia | null;
  promise: Promise<LoadedMedia>;
}

const cache = new Map<string, MediaEntry>();

function acquire(url: string): MediaEntry {
  const existing = cache.get(url);
  if (existing) {
    existing.refs += 1;
    return existing;
  }

  const promise: Promise<LoadedMedia> = fetchAuthenticatedBlob(resolveMediaUrl(url)).then(
    ({ blob, fileName }) => {
      const loaded = { objectUrl: URL.createObjectURL(blob), fileName };
      const alive = cache.get(url);
      // Todos soltaram antes de chegar: ninguém vai usar — não deixa preso.
      if (alive?.promise === promise) alive.loaded = loaded;
      else URL.revokeObjectURL(loaded.objectUrl);
      return loaded;
    },
    (error: unknown) => {
      // Erro não fica em cache: a próxima montagem tenta de novo.
      if (cache.get(url)?.promise === promise) cache.delete(url);
      throw error;
    },
  );
  const entry: MediaEntry = { refs: 1, loaded: null, promise };
  cache.set(url, entry);
  return entry;
}

function release(url: string, entry: MediaEntry): void {
  entry.refs -= 1;
  if (entry.refs > 0 || cache.get(url) !== entry) return;
  cache.delete(url);
  if (entry.loaded) URL.revokeObjectURL(entry.loaded.objectUrl);
}

function snapshot(url: string | null): UseAuthenticatedMediaResult {
  const loaded = url ? cache.get(url)?.loaded : null;
  if (loaded) {
    return {
      objectUrl: loaded.objectUrl,
      fileName: loaded.fileName,
      isLoading: false,
      isError: false,
    };
  }
  return { objectUrl: null, fileName: null, isLoading: url !== null, isError: false };
}

/**
 * Carrega uma mídia servida por endpoint AUTENTICADO (`GET /media/:id`) como
 * `object URL`, para usar em `<img src>`/`<audio src>`/`<a href>` — que nunca
 * mandam `Authorization` sozinhos (CRMLAB-15, CRMLAB-2).
 *
 * Devolve também o nome original do arquivo, que o `object URL` não carrega —
 * é ele que dá nome ao download da imagem (CRMLAB-26).
 *
 * `url: null` (ex. lightbox fechado) não busca nada. O blob é compartilhado
 * por URL enquanto alguém o usa (D-245): o lightbox aberto a partir do balão
 * recebe na hora o que o balão já baixou, sem outro GET. Quando o último
 * usuário da URL solta, o object URL é revogado — sem isso o blob ficaria
 * preso na memória do browser pelo resto da sessão.
 */
export function useAuthenticatedMedia(url: string | null): UseAuthenticatedMediaResult {
  const [state, setState] = useState<{ url: string | null; result: UseAuthenticatedMediaResult }>(
    () => ({ url, result: snapshot(url) }),
  );
  // Troca de URL: o render já sai com o blob em cache (ou "carregando"), sem
  // um quadro com a imagem anterior.
  const current = state.url === url ? state.result : snapshot(url);

  useEffect(() => {
    if (!url) {
      setState({ url, result: snapshot(null) });
      return;
    }

    let cancelled = false;
    const entry = acquire(url);
    setState({ url, result: snapshot(url) });

    entry.promise
      .then(({ objectUrl, fileName }) => {
        if (cancelled) return;
        setState({ url, result: { objectUrl, fileName, isLoading: false, isError: false } });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          url,
          result: { objectUrl: null, fileName: null, isLoading: false, isError: true },
        });
      });

    return () => {
      cancelled = true;
      release(url, entry);
    };
  }, [url]);

  return current;
}
