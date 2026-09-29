import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/api';

/**
 * `useAuthenticatedMedia` — blob compartilhado por URL (CRMLAB-64, D-245):
 * quem pede a mesma URL enquanto ela está em uso recebe o mesmo object URL,
 * sem novo GET; o último a soltar revoga.
 */
const fetchAuthenticatedBlobMock = vi.fn();
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, fetchAuthenticatedBlob: fetchAuthenticatedBlobMock };
});

const { useAuthenticatedMedia } = await import('./useAuthenticatedMedia');

let created = 0;
beforeEach(() => {
  fetchAuthenticatedBlobMock.mockReset();
  fetchAuthenticatedBlobMock.mockResolvedValue({
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    fileName: 'foto.jpg',
  });
  created = 0;
  URL.createObjectURL = vi.fn(() => `blob:media-${++created}`);
  URL.revokeObjectURL = vi.fn();
});

describe('useAuthenticatedMedia', () => {
  it('null não busca nada', () => {
    const { result } = renderHook(() => useAuthenticatedMedia(null));
    expect(result.current).toEqual({ objectUrl: null, fileName: null, isLoading: false, isError: false });
    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();
  });

  it('segundo usuário da mesma URL recebe o blob na hora, sem outro GET', async () => {
    const first = renderHook(() => useAuthenticatedMedia('/api/v1/media/a'));
    await waitFor(() => expect(first.result.current.objectUrl).toBe('blob:media-1'));

    const second = renderHook(() => useAuthenticatedMedia('/api/v1/media/a'));
    // Já no primeiro render — o lightbox abre sem "carregando".
    expect(second.result.current).toEqual({
      objectUrl: 'blob:media-1',
      fileName: 'foto.jpg',
      isLoading: false,
      isError: false,
    });
    expect(fetchAuthenticatedBlobMock).toHaveBeenCalledTimes(1);

    // Um soltar não revoga: o outro ainda usa.
    second.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    first.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1');
  });

  it('dois pedindo ao mesmo tempo fazem um GET só', async () => {
    const a = renderHook(() => useAuthenticatedMedia('/api/v1/media/b'));
    const b = renderHook(() => useAuthenticatedMedia('/api/v1/media/b'));
    await waitFor(() => expect(b.result.current.objectUrl).toBe('blob:media-1'));
    expect(a.result.current.objectUrl).toBe('blob:media-1');
    expect(fetchAuthenticatedBlobMock).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it('solto antes de chegar: o blob que chega é revogado na hora', async () => {
    let resolve: (value: { blob: Blob; fileName: string }) => void = () => {};
    fetchAuthenticatedBlobMock.mockReturnValue(new Promise((done) => (resolve = done)));
    const { unmount } = renderHook(() => useAuthenticatedMedia('/api/v1/media/c'));
    unmount();

    resolve({ blob: new Blob(['x']), fileName: 'c.jpg' });
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1'));
  });

  it('erro não fica em cache: a próxima montagem tenta de novo', async () => {
    fetchAuthenticatedBlobMock.mockRejectedValueOnce(new Error('rede'));
    const first = renderHook(() => useAuthenticatedMedia('/api/v1/media/d'));
    await waitFor(() => expect(first.result.current.isError).toBe(true));
    first.unmount();

    const second = renderHook(() => useAuthenticatedMedia('/api/v1/media/d'));
    await waitFor(() => expect(second.result.current.objectUrl).toBe('blob:media-1'));
    expect(fetchAuthenticatedBlobMock).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('trocar de URL solta a anterior', async () => {
    const { result, rerender, unmount } = renderHook(({ url }) => useAuthenticatedMedia(url), {
      initialProps: { url: '/api/v1/media/e' },
    });
    await waitFor(() => expect(result.current.objectUrl).toBe('blob:media-1'));

    rerender({ url: '/api/v1/media/f' });
    // O render da troca já não mostra a imagem anterior.
    expect(result.current.objectUrl === 'blob:media-1').toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1');
    await waitFor(() => expect(result.current.objectUrl).toBe('blob:media-2'));
    unmount();
  });
});
