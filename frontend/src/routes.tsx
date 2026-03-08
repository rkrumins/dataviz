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
import { AdminDataSourcesOverview } from '@/components/admin/AdminDataSourcesOverview'

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
          { index: true, element: <Navigate to="data-sources" replace /> },
          { path: 'data-sources', element: <AdminDataSourcesOverview /> },
          { path: 'data-sources/providers', element: <AdminProviders /> },
          { path: 'data-sources/workspaces', element: <AdminWorkspaces /> },
          { path: 'data-sources/workspaces/:wsId', element: <AdminWorkspaceDetail /> },
          { path: 'data-sources/insights', element: <AdminInsights /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

