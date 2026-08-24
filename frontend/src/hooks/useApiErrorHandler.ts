import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/components/ui';
import { createApiErrorHandler } from '@/api';
import type { ApiErrorHandler } from '@/api';
import { useAuthStore } from '@/stores';

/**
 * Liga o `switch (error.code)` de `api/error-handler.ts` ao toast e ao router.
 * Telas usam ASSIM:
 *
 * ```tsx
 * const handleApiError = useApiErrorHandler();
 * const { mutate } = useMutation({ mutationFn: ..., onError: handleApiError });
 * ```
 *
 * Para erro com UX própria, trate PRIMEIRO por código e delegue o resto:
 * ```tsx
 * onError: (error) => {
 *   if (isApiError(error) && error.code === 'DISCOUNT_EXCEEDS_LIMIT') return showApprovalHint(error.details);
 *   handleApiError(error);
 * }
 * ```
 */
export function useApiErrorHandler(): ApiErrorHandler {
  const { toast } = useToast();
  const navigate = useNavigate();
  const clearSession = useAuthStore((state) => state.clearSession);

  const redirectToLogin = useCallback(() => {
    clearSession();
    navigate('/login', { replace: true });
  }, [clearSession, navigate]);

  return useMemo(
    () => createApiErrorHandler({ toast, redirectToLogin }),
    [toast, redirectToLogin],
  );
}
