import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './routes'
import './styles/globals.css'
import { GraphProvider } from '@/providers/GraphProviderContext'
import { BackendHealthBanner } from '@/components/layout/BackendHealthBanner'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5 minutes default stale time
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// GraphProvider manages the RemoteGraphProvider lifecycle internally,
// creating a workspace-scoped instance whenever the active workspace changes.
// RouterProvider handles URL-based navigation; AppLayout (inside routes)
// manages auth, schema init, and the shell (TopBar + SidebarNav + Outlet).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="h-screen w-screen flex flex-col overflow-hidden">
        <BackendHealthBanner />
        <div className="flex-1 overflow-hidden">
          <GraphProvider>
            <RouterProvider router={router} />
          </GraphProvider>
        </div>
      </div>
    </QueryClientProvider>
  </React.StrictMode>,
)
