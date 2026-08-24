import { useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isApiError } from '@/api';
import { Button, Input } from '@/components/ui';
import { useLogin } from '@/hooks';

/**
 * Login (`/login`) — PAGES.md §1.
 *
 * `POST /auth/login` → guarda os tokens no `useAuthStore` → **aplica o tema que
 * veio no MESMO payload** (`setSession` chama `applyTheme`; nenhum request
 * extra de tema, FRONTEND_BACKEND.md) → redireciona pelo papel.
 *
 * Mensagem de erro GENÉRICA: o backend devolve `INVALID_CREDENTIALS` tanto para
 * e-mail inexistente quanto para senha errada — a UI não pode estragar isso
 * dizendo qual dos dois falhou (SECURITY.md, "não ser oráculo").
 */

/** Uma frase para e-mail inexistente E senha errada. Não revela qual foi. */
export const GENERIC_CREDENTIALS_ERROR = 'Credenciais inválidas.';
/** Falha de infraestrutura — nada a ver com as credenciais. */
export const SYSTEM_ERROR = 'Não foi possível entrar agora. Tente novamente em instantes.';
/** Campo vazio: validação local, sem ida ao servidor. */
export const EMPTY_FIELDS_ERROR = 'Informe e-mail e senha.';

/**
 * Códigos que a UI trata como "credenciais inválidas". `USER_INACTIVE` e
 * `TENANT_INACTIVE` entram aqui de propósito: dizer "sua conta está inativa"
 * confirma que a conta existe.
 */
const CREDENTIAL_CODES = new Set([
  'INVALID_CREDENTIALS',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'USER_INACTIVE',
  'TENANT_INACTIVE',
]);

function messageFor(error: unknown): string {
  if (isApiError(error) && CREDENTIAL_CODES.has(error.code)) return GENERIC_CREDENTIALS_ERROR;
  return SYSTEM_ERROR;
}

export function Login() {
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** De onde o guard mandou o usuário para cá (PAGES.md — "Guard de rotas"). */
  const from = (location.state as { from?: string } | null)?.from;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    if (email.trim().length === 0 || password.length === 0) {
      setError(EMPTY_FIELDS_ERROR);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const home = await login({ email: email.trim(), password });
      navigate(from ?? home, { replace: true });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-bg px-lg font-body text-body text-text">
      <form
        onSubmit={handleSubmit}
        aria-labelledby="login-title"
        noValidate
        style={{ maxWidth: 380 }}
        className="flex w-full flex-col gap-lg rounded-lg bg-neutral-100 px-xl py-xl shadow-sm"
      >
        <header className="flex flex-col gap-xs">
          <h1 id="login-title" className="m-0 font-heading text-section text-text">
            Entrar
          </h1>
          <p className="m-0 text-caption text-neutral-600">
            Acesse o atendimento do seu laboratório.
          </p>
        </header>

        <Input
          label="E-mail"
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          placeholder="voce@laboratorio.com"
        />

        <Input
          label="Senha"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          placeholder="Sua senha"
        />

        {error && (
          <p role="alert" className="m-0 text-caption font-semibold text-accent-700">
            {error}
          </p>
        )}

        <Button type="submit" loading={submitting}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </main>
  );
}

export default Login;
