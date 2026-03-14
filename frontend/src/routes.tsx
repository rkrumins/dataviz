import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { NotFoundPage } from '@/pages/NotFoundPage'

// Lazy-load all page-level components so their module code and hooks only
// run when the user actually navigates to that route.
const Dashboard = lazy(() => import('@/components/dashboard/Dashboard').then(m => ({ default: m.Dashboard })))
const ViewPage = lazy(() => import('@/pages/ViewPage').then(m => ({ default: m.ViewPage })))
const ViewsGallery = lazy(() => import('@/pages/ViewsGallery').then(m => ({ default: m.ViewsGallery })))
const WorkspaceView = lazy(() => import('@/pages/WorkspaceView').then(m => ({ default: m.WorkspaceView })))
const WorkspaceViewsManager = lazy(() => import('@/pages/WorkspaceViewsManager').then(m => ({ default: m.WorkspaceViewsManager })))
const ExplorerPage = lazy(() => import('@/pages/ExplorerPage').then(m => ({ default: m.ExplorerPage })))
const AdminPage = lazy(() => import('@/pages/AdminPage').then(m => ({ default: m.AdminPage })))
const AdminOverview = lazy(() => import('@/components/admin/AdminOverview').then(m => ({ default: m.AdminOverview })))
const AdminRegistry = lazy(() => import('@/components/admin/AdminRegistry').then(m => ({ default: m.AdminRegistry })))
const AdminWorkspaceDetail = lazy(() => import('@/components/admin/AdminWorkspaceDetail').then(m => ({ default: m.AdminWorkspaceDetail })))

// Thin suspense wrapper used for each lazy route — shows a centred spinner.
function PageLoader() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas">
      <div className="w-6 h-6 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Lazy><Dashboard /></Lazy> },
      { path: 'explorer', element: <Lazy><ExplorerPage /></Lazy> },
      { path: 'views', element: <Lazy><ViewsGallery /></Lazy> },
      { path: 'views/:viewId', element: <Lazy><ViewPage /></Lazy> },
      { path: 'workspaces/:workspaceId', element: <Lazy><WorkspaceView /></Lazy> },
      { path: 'workspaces/:workspaceId/views', element: <Lazy><WorkspaceViewsManager /></Lazy> },
      { path: 'schema', element: <Lazy><Dashboard /></Lazy> },
      {
        path: 'admin',
        element: <Lazy><AdminPage /></Lazy>,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: 'overview', element: <Lazy><AdminOverview /></Lazy> },
          { path: 'registry', element: <Lazy><AdminRegistry /></Lazy> },
          { path: 'registry/workspaces/:wsId', element: <Lazy><AdminWorkspaceDetail /></Lazy> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
