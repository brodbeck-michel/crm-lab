import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui';
import { queryClient } from '@/api/query-client';
import { useAppWebSocket, useSessionBootstrap } from '@/hooks';
import { appRoutes } from '@/routes';
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

export function App() {
  // CRMLAB-32: access token só em memória — cada carga de página troca o
  // cookie httpOnly por um access token novo antes de o router (e os guards
  // de rota) renderizar. Sem tela de loading própria: a troca é rápida e uma
  // tela em branco por um instante é preferível a piscar `/login` para uma
  // sessão válida.
  const sessionReady = useSessionBootstrap();
  if (!sessionReady) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RealtimeBridge />
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
