import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui';
import { queryClient } from '@/api/query-client';
import { useAppWebSocket } from '@/hooks';
import { appRoutes } from '@/routes';
import { useUIStore } from '@/stores';
import ProposalModal from '@/components/proposal/ProposalModal';
import '@/stores'; // registra a ponte de sessão do client HTTP

/**
 * Raiz da aplicação.
 *
 * Ordem dos providers (importa):
 *   QueryClientProvider → ToastProvider → RouterProvider
 * O `ToastProvider` fica ACIMA do router porque os guards de rota emitem
 * toast ao barrar um perfil sem permissão.
 */

const router = createBrowserRouter(appRoutes);

/** Conexão WS viva enquanto houver sessão — invalida queries ao receber evento. */
function RealtimeBridge() {
  useAppWebSocket();
  return null;
}

/** Modais globais montadas na raiz. */
function GlobalModals() {
  const modal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);

  if (!modal) return null;

  if (modal.kind === 'proposal' && modal.id) {
    return <ProposalModal proposalId={modal.id} onClose={closeModal} />;
  }

  return null;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RealtimeBridge />
        <GlobalModals />
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
