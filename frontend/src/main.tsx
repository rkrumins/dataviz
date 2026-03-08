import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './routes'
import './styles/globals.css'
import { GraphProvider } from '@/providers/GraphProviderContext'

// GraphProvider manages the RemoteGraphProvider lifecycle internally,
// creating a workspace-scoped instance whenever the active workspace changes.
// RouterProvider handles URL-based navigation; AppLayout (inside routes)
// manages auth, schema init, and the shell (TopBar + SidebarNav + Outlet).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GraphProvider>
      <RouterProvider router={router} />
    </GraphProvider>
  </React.StrictMode>,
)
