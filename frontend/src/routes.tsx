import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { CanvasLayout } from '@/components/layout/CanvasLayout'
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
const AdminFeatures = lazy(() => import('@/components/admin/AdminFeatures/index').then(m => ({ default: m.AdminFeatures })))
const AdminWorkspaceDetail = lazy(() => import('@/components/admin/AdminWorkspaceDetail').then(m => ({ default: m.AdminWorkspaceDetail })))
const AdminUsers = lazy(() => import('@/components/admin/AdminUsers').then(m => ({ default: m.AdminUsers })))
const AdminAnnouncements = lazy(() => import('@/components/admin/AdminAnnouncements/index').then(m => ({ default: m.AdminAnnouncements })))
const OntologySchemaPage = lazy(() => import('@/pages/OntologySchemaPage').then(m => ({ default: m.OntologySchemaPage })))

// Auth pages (unauthenticated)
const LoginPage = lazy(() => import('@/components/auth/LoginPage').then(m => ({ default: m.LoginPage })))
const SignUpPage = lazy(() => import('@/components/auth/SignUpPage').then(m => ({ default: m.SignUpPage })))
const ForgotPasswordPage = lazy(() => import('@/components/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })))
const ResetPasswordPage = lazy(() => import('@/components/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })))

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
  // Unauthenticated routes
  { path: '/login', element: <Lazy><LoginPage /></Lazy> },
  { path: '/signup', element: <Lazy><SignUpPage /></Lazy> },
  { path: '/forgot-password', element: <Lazy><ForgotPasswordPage /></Lazy> },
  { path: '/reset-password', element: <Lazy><ResetPasswordPage /></Lazy> },

  // Authenticated routes (guarded by AppLayout)
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Lazy><Dashboard /></Lazy> },
      // CanvasLayout gates these routes behind a schema fetch so the heavy
      // ontology data only loads when the user navigates to a canvas section.
      {
        element: <CanvasLayout />,
        children: [
          { path: 'explorer', element: <Lazy><ExplorerPage /></Lazy> },
          { path: 'views', element: <Lazy><ViewsGallery /></Lazy> },
          { path: 'views/:viewId', element: <Lazy><ViewPage /></Lazy> },
          { path: 'workspaces/:workspaceId', element: <Lazy><WorkspaceView /></Lazy> },
          { path: 'workspaces/:workspaceId/views', element: <Lazy><WorkspaceViewsManager /></Lazy> },
          { path: 'schema', element: <Lazy><OntologySchemaPage /></Lazy> },
          { path: 'schema/:ontologyId', element: <Lazy><OntologySchemaPage /></Lazy> },
        ],
      },
      {
        path: 'admin',
        element: <Lazy><AdminPage /></Lazy>,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: 'overview', element: <Lazy><AdminOverview /></Lazy> },
          { path: 'registry', element: <Lazy><AdminRegistry /></Lazy> },
          { path: 'features', element: <Lazy><AdminFeatures /></Lazy> },
          { path: 'users', element: <Lazy><AdminUsers /></Lazy> },
          { path: 'announcements', element: <Lazy><AdminAnnouncements /></Lazy> },
          { path: 'registry/workspaces/:wsId', element: <Lazy><AdminWorkspaceDetail /></Lazy> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
