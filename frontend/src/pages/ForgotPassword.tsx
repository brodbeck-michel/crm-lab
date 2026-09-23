import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input } from '@/components/ui';
import { useForgotPassword } from '@/api/auth';

/**
 * "Esqueci minha senha" (`/forgot-password`) — CRMLAB-39.
 *
 * A resposta do backend é SEMPRE a mesma mensagem de sucesso, exista ou não o
 * e-mail (anti-oráculo, mesmo desenho do login) — a tela não tem como (nem
 * deve tentar) dizer se a conta existe.
 */
export function ForgotPassword() {
  const forgotPassword = useForgotPassword();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (email.trim().length === 0 || forgotPassword.isPending) return;
    await forgotPassword.mutateAsync({ email: email.trim() }).catch(() => undefined);
    // Mesmo em erro de rede a tela segue para a mensagem genérica — não é
    // oráculo também no sentido "tentou e falhou visivelmente".
    setSent(true);
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg px-lg font-body text-body text-text">
      <div
        style={{ maxWidth: 380 }}
        className="flex w-full flex-col gap-lg rounded-lg bg-neutral-100 px-xl py-xl shadow-sm"
      >
        <header className="flex flex-col gap-xs">
          <h1 className="m-0 font-heading text-section text-text">Esqueci minha senha</h1>
          <p className="m-0 text-caption text-neutral-600">
            Informe seu e-mail de acesso e enviaremos um link para redefinir a senha.
          </p>
        </header>

        {sent ? (
          <p role="status" className="m-0 text-body text-text">
            Se o e-mail existir, você receberá um link de redefinição de senha em instantes.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-lg" noValidate>
            <Input
              label="E-mail"
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={forgotPassword.isPending}
              placeholder="voce@laboratorio.com"
            />
            <Button type="submit" loading={forgotPassword.isPending}>
              Enviar link
            </Button>
          </form>
        )}

        <Link to="/login" className="text-caption text-neutral-600 underline">
          Voltar para o login
        </Link>
      </div>
    </main>
  );
}

export default ForgotPassword;
