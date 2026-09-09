import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { apiClient } from './api/client';
import { useAuthStore } from './auth/store';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

// Wire the API client to the auth store. The base URL is the SPA's own
// origin so the Hono server handles /auth, /admin, /api, etc. The dev
// Vite proxy (vite.config.ts) forwards them to localhost:8787.
apiClient.setBaseUrl(window.location.origin);
apiClient.setTokenProvider(() => useAuthStore.getState().token);
apiClient.setRefresh(async () => {
  const r = await apiClient.post<{ token: string }>('/auth/refresh');
  useAuthStore.getState().login(r.token);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);