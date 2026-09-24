import { useState } from 'react';
import { useChangePassword } from '@/api/users';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, useToast } from '@/components/ui';

/**
 * Minha Conta (`/settings/account`) — CRMLAB-35. Troca da própria senha,
 * autenticada. A recuperação SEM sessão (esqueci minha senha) é uma tela
 * pública separada (`/forgot-password`, CRMLAB-39) — não fica aqui dentro.
 *
 * Disponível para TODOS os papéis de tenant: trocar a própria senha não é
 * privilégio de admin. O mínimo de 10 caracteres aqui é UX — quem decide é
 * `checkPasswordPolicy` no backend (D-153), e a mensagem de erro dele é a que
 * aparece na tela.
 */
const MIN_PASSWORD_LENGTH = 10;

const EMPTY_FORM = { currentPassword: '', newPassword: '', confirmPassword: '' };

export default function Account() {
  const user = useAuthStore((s) => s.user);
  const { toast } = useToast();
  const changePassword = useChangePassword();

  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});

    // Confirmação é só desta tela: o backend não conhece `confirmPassword`.
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
      setFieldErrors({ newPassword: 'A nova senha precisa ser diferente da atual' });
      return;
    }

    changePassword.mutate(
      { currentPassword: form.currentPassword, newPassword: form.newPassword },
      {
        onSuccess: () => {
          setForm(EMPTY_FORM);
          toast('Senha alterada. As outras sessões foram encerradas.', { tone: 'positive' });
        },
        onError: (err) => {
          const fields = (err as { details?: { fields?: Record<string, string> } })?.details
            ?.fields;
          setFieldErrors(fields ?? {});
          if (!fields) toast('Não foi possível alterar a senha.', { tone: 'attention' });
        },
      },
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Minha Conta"
        description="Seus dados de acesso. Alterar a senha encerra suas sessões nos outros dispositivos."
      />

      <div className="space-y-lg max-w-md">
        <dl className="space-y-sm font-body text-body">
          <div>
            <dt className="text-neutral-600">Nome</dt>
            <dd className="text-text">{user?.name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-neutral-600">E-mail</dt>
            <dd className="text-text">{user?.email ?? '—'}</dd>
          </div>
        </dl>

        <form onSubmit={handleSubmit} className="space-y-md" aria-label="Alterar senha">
          <h2 className="m-0 font-heading text-section text-text">Alterar senha</h2>

          <Input
            type="password"
            label="Senha atual"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
            error={fieldErrors.currentPassword}
          />
          <Input
            type="password"
            label="Nova senha"
            hint={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres. Evite senhas óbvias.`}
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            error={fieldErrors.newPassword}
          />
          <Input
            type="password"
            label="Confirmar nova senha"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
            error={fieldErrors.confirmPassword}
          />

          <Button
            type="submit"
            variant="primary"
            loading={changePassword.isPending}
            disabled={!form.currentPassword || !form.newPassword || !form.confirmPassword}
          >
            Alterar senha
          </Button>
        </form>
      </div>
    </PageContainer>
  );
}
