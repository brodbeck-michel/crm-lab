import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { isApiError } from '@/api';
import { refreshAccessToken } from '@/api/client';
import { useChangePassword } from '@/api/users';
import { Button, PasswordInput } from '@/components/ui';
import { useLogout } from '@/hooks/useSession';
import { homeFor } from '@/routes/route-config';
import { selectMustChangePassword, selectRole, useAuthStore } from '@/stores';

const MIN_PASSWORD_LENGTH = 10;
const EMPTY_FORM = { currentPassword: '', newPassword: '', confirmPassword: '' };

/**
 * Troca obrigatória da senha provisória (`/change-password`) — CRMLAB-186, D-326.
 *
 * Quem entrou com a senha gerada pelo admin (ou pelo console) cai aqui e não sai
 * até trocar: o `RequireAuth` redireciona e o servidor recusa o resto com
 * `PASSWORD_CHANGE_REQUIRED`. Depois do `PATCH /users/me/password`, o
 * `POST /auth/refresh` traz um access token sem o claim — só então a flag do
 * store desliga e o usuário segue para a home do papel.
 */
export function ChangePassword() {
  const mustChangePassword = useAuthStore(selectMustChangePassword);
  const role = useAuthStore(selectRole);
  const setMustChangePassword = useAuthStore((s) => s.setMustChangePassword);
  const changePassword = useChangePassword();
  const logout = useLogout();
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  if (!mustChangePassword) {
    return <Navigate to={homeFor(role)} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFieldErrors({});
    setError(null);

    if (form.newPassword !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'As senhas não conferem' });
      return;
    }
    if (form.newPassword.length < MIN_PASSWORD_LENGTH) {
      setFieldErrors({
        newPassword: `Nova senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`,
      });
      return;
    }
    if (form.newPassword === form.currentPassword) {
      setFieldErrors({ newPassword: 'A nova senha precisa ser diferente da provisória' });
      return;
    }

    try {
      await changePassword.mutateAsync({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
    } catch (caught) {
      const fields =
        isApiError(caught) && caught.code === 'VALIDATION_ERROR'
          ? (caught.details?.fields as Record<string, string> | undefined)
          : undefined;
      if (fields) {
        setFieldErrors(
          fields.currentPassword
            ? { ...fields, currentPassword: 'Senha provisória incorreta' }
            : fields,
        );
      } else {
        setError('Não foi possível trocar a senha agora. Tente novamente.');
      }
      return;
    }

    // Senha trocada no servidor. O token atual ainda carrega o claim: renova
    // antes de liberar a navegação, senão a próxima tela volta 403.
    setFinishing(true);
    try {
      await refreshAccessToken();
    } catch {
      // Refresh falhou (rede/sessão): o interceptor já cuida de deslogar no 401.
      // A senha nova vale de qualquer jeito — no pior caso, o próximo login entra limpo.
    }
    setMustChangePassword(false);
    navigate(homeFor(role), { replace: true });
  }

  const busy = changePassword.isPending || finishing;

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg px-lg font-body text-body text-text">
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label="Trocar senha provisória"
        className="flex w-full max-w-sm flex-col gap-lg rounded-lg bg-neutral-100 px-xl py-xl shadow-sm"
      >
        <header className="flex flex-col gap-xs">
          <h1 className="m-0 font-heading text-section text-text">Crie sua nova senha</h1>
          <p className="m-0 text-caption text-neutral-600">
            Você entrou com uma senha provisória. Para continuar, escolha uma senha só sua.
          </p>
        </header>

        <PasswordInput
          label="Senha provisória"
          autoComplete="current-password"
          value={form.currentPassword}
          onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
          error={fieldErrors.currentPassword}
          disabled={busy}
        />
        <PasswordInput
          label="Nova senha"
          hint={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres. Evite senhas óbvias.`}
          autoComplete="new-password"
          value={form.newPassword}
          onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          error={fieldErrors.newPassword}
          disabled={busy}
        />
        <PasswordInput
          label="Confirmar nova senha"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
          error={fieldErrors.confirmPassword}
          disabled={busy}
        />

        {error && (
          <p role="alert" className="m-0 text-caption font-semibold text-accent-700">
            {error}
          </p>
        )}

        <Button type="submit" loading={busy}>
          Salvar nova senha
        </Button>
        <button
          type="button"
          onClick={() => void logout()}
          className="self-center border-none bg-transparent text-caption text-neutral-600 underline"
        >
          Sair
        </button>
      </form>
    </main>
  );
}
