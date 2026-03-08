import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { Dashboard } from '@/components/dashboard/Dashboard'
import { ViewPage } from '@/pages/ViewPage'
import { ViewsGallery } from '@/pages/ViewsGallery'
import { WorkspaceView } from '@/pages/WorkspaceView'
import { WorkspaceViewsManager } from '@/pages/WorkspaceViewsManager'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { AdminPage } from '@/pages/AdminPage'
import { AdminProviders } from '@/components/admin/AdminProviders'
import { AdminWorkspaces } from '@/components/admin/AdminWorkspaces'
import { AdminWorkspaceDetail } from '@/components/admin/AdminWorkspaceDetail'
import { AdminInsights } from '@/components/admin/AdminInsights'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'views', element: <ViewsGallery /> },
      { path: 'views/:viewId', element: <ViewPage /> },
      { path: 'workspaces/:workspaceId', element: <WorkspaceView /> },
      { path: 'workspaces/:workspaceId/views', element: <WorkspaceViewsManager /> },
      { path: 'schema', element: <Dashboard /> }, // Schema editor — placeholder until dedicated component extracted
      {
        path: 'admin',
        element: <AdminPage />,
        children: [
          { index: true, element: <Navigate to="workspaces" replace /> },
          { path: 'providers', element: <AdminProviders /> },
          { path: 'workspaces', element: <AdminWorkspaces /> },
          { path: 'workspaces/:wsId', element: <AdminWorkspaceDetail /> },
          { path: 'insights', element: <AdminInsights /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

