import type { ManagedUser } from '@crm-lab/shared';
import { useResetUserPassword } from '@/api/users';
import { Modal } from '@/components/shared';
import { Button } from '@/components/ui';

export interface ResetPasswordDialogProps {
  /** Usuário a resetar; `null` fecha o diálogo. */
  user: ManagedUser | null;
  onClose: () => void;
}

/**
 * Reset de senha pelo admin (CRMLAB-186, D-326): confirmação → senha provisória
 * mostrada UMA vez. A senha só existe no estado da mutation; fechar o diálogo
 * zera esse estado e ela não volta (mesmo modelo do console, `TenantDetail`).
 */
export default function ResetPasswordDialog({ user, onClose }: ResetPasswordDialogProps) {
  const reset = useResetUserPassword();
  const issued = reset.data;

  const close = () => {
    reset.reset();
    onClose();
  };

  if (issued) {
    return (
      <Modal
        open
        onClose={close}
        title="Senha provisória gerada"
        footer={
          <Button variant="confirmation" onClick={close}>
            Fechar
          </Button>
        }
      >
        <div className="flex flex-col gap-sm">
          <p className="m-0 font-body text-body text-text">
            Repasse esta senha a <strong>{issued.email}</strong>. Ela não será mostrada de novo
            depois de fechar esta janela.
          </p>
          <div className="flex items-center gap-sm rounded-lg bg-neutral-100 px-lg py-md">
            <code className="flex-1 font-mono text-body tracking-wide text-text">
              {issued.temporaryPassword}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(issued.temporaryPassword)}
            >
              Copiar
            </Button>
          </div>
          <p className="m-0 font-body text-caption text-neutral-600">
            No primeiro acesso com ela, o sistema pede para criar uma senha nova.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={user !== null}
      onClose={close}
      title="Resetar senha"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={reset.isPending}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            loading={reset.isPending}
            onClick={() => {
              if (user) reset.mutate(user.id);
            }}
          >
            Resetar senha
          </Button>
        </>
      }
    >
      <p className="m-0 font-body text-body text-text">
        Uma senha provisória substitui a senha de <strong>{user?.name}</strong> ({user?.email}) na
        hora. A senha atual deixa de funcionar e as sessões abertas são encerradas.
      </p>
      {reset.isError && (
        <p role="alert" className="m-0 mt-sm font-body text-caption text-accent-700">
          Não foi possível resetar a senha. Tente novamente.
        </p>
      )}
    </Modal>
  );
}
