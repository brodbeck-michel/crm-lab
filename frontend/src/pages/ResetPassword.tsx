import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { isApiError } from '@/api';
import { Button, Input } from '@/components/ui';
import { useResetPassword } from '@/api/auth';

const MIN_PASSWORD_LENGTH = 10;

/**
 * Redefinir senha (`/reset-password?token=...`) — CRMLAB-39.
 *
 * `token` vem do link do e-mail. `RESET_TOKEN_INVALID` cobre token
 * inexistente, já usado OU vencido — a UI não distingue os três casos,
 * mesma lógica de não ser oráculo do backend (D-172).
 */
export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const resetPassword = useResetPassword();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('As senhas não conferem');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Nova senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`);
      return;
    }

    try {
      await resetPassword.mutateAsync({ token, newPassword });
      navigate('/login', { replace: true });
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'RESET_TOKEN_INVALID') {
        setError('Link inválido ou expirado. Solicite um novo.');
      } else if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        const fields = caught.details?.fields as Record<string, string> | undefined;
        setError(fields?.newPassword ?? 'Não foi possível redefinir a senha.');
      } else {
        setError('Não foi possível redefinir a senha agora. Tente novamente.');
      }
    }
  }

  if (!token) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center bg-bg px-lg font-body text-body text-text">
        <div className="flex flex-col gap-md text-center">
          <p role="alert" className="m-0">
            Link de redefinição inválido. Solicite um novo em &quot;Esqueci minha senha&quot;.
          </p>
          <Link to="/forgot-password" className="text-caption text-neutral-600 underline">
            Esqueci minha senha
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg px-lg font-body text-body text-text">
      <form
        onSubmit={handleSubmit}
        noValidate
        style={{ maxWidth: 380 }}
        className="flex w-full flex-col gap-lg rounded-lg bg-neutral-100 px-xl py-xl shadow-sm"
      >
        <header className="flex flex-col gap-xs">
          <h1 className="m-0 font-heading text-section text-text">Redefinir senha</h1>
          <p className="m-0 text-caption text-neutral-600">Escolha uma nova senha de acesso.</p>
        </header>

        <Input
          type="password"
          label="Nova senha"
          hint={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres. Evite senhas óbvias.`}
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          disabled={resetPassword.isPending}
        />
        <Input
          type="password"
          label="Confirmar nova senha"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          disabled={resetPassword.isPending}
        />

        {error && (
          <p role="alert" className="m-0 text-caption font-semibold text-accent-700">
            {error}
          </p>
        )}

        <Button type="submit" loading={resetPassword.isPending}>
          Redefinir senha
        </Button>
      </form>
    </main>
  );
}

export default ResetPassword;
