import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, useParams } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { CanvasLayout } from '@/components/layout/CanvasLayout'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { RequireNav } from '@/components/auth/RequireNav'

// The standalone workspace-views page was retired; view management now lives
// in the workspace-detail "Views" tab. Redirect any old link there.
function WorkspaceViewsRedirect() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  return <Navigate to={`/workspaces/${workspaceId}?tab=views`} replace />
}

// Lazy-load all page-level components so their module code and hooks only
// run when the user actually navigates to that route.
const Dashboard = lazy(() => import('@/components/dashboard/Dashboard').then(m => ({ default: m.Dashboard })))
const ViewPage = lazy(() => import('@/pages/ViewPage').then(m => ({ default: m.ViewPage })))
const ViewsGallery = lazy(() => import('@/pages/ViewsGallery').then(m => ({ default: m.ViewsGallery })))
const ExplorerPage = lazy(() => import('@/pages/ExplorerPage').then(m => ({ default: m.ExplorerPage })))
const AdminPage = lazy(() => import('@/pages/AdminPage').then(m => ({ default: m.AdminPage })))
const AdminOverview = lazy(() => import('@/components/admin/AdminOverview').then(m => ({ default: m.AdminOverview })))
const AdminInfrastructure = lazy(() => import('@/components/admin/AdminInfrastructure').then(m => ({ default: m.AdminInfrastructure })))
const AdminBranding = lazy(() => import('@/components/admin/AdminBranding').then(m => ({ default: m.AdminBranding })))
const AdminFeatures = lazy(() => import('@/components/admin/AdminFeatures/index').then(m => ({ default: m.AdminFeatures })))
const AdminUsers = lazy(() => import('@/components/admin/AdminUsers').then(m => ({ default: m.AdminUsers })))
const AdminGroups = lazy(() => import('@/components/admin/AdminGroups').then(m => ({ default: m.AdminGroups })))
const AdminPermissions = lazy(() => import('@/components/admin/AdminPermissions').then(m => ({ default: m.AdminPermissions })))
const AdminAnnouncements = lazy(() => import('@/components/admin/AdminAnnouncements/index').then(m => ({ default: m.AdminAnnouncements })))
const AdminSso = lazy(() => import('@/components/admin/AdminSso').then(m => ({ default: m.AdminSso })))
const AdminAudit = lazy(() => import('@/components/admin/AdminAudit').then(m => ({ default: m.AdminAudit })))
const IngestionPage = lazy(() => import('@/pages/IngestionPage').then(m => ({ default: m.IngestionPage })))
const DataSourceOverviewPage = lazy(() => import('@/pages/DataSourceOverviewPage').then(m => ({ default: m.DataSourceOverviewPage })))
const WorkspacesPage = lazy(() => import('@/pages/WorkspacesPage').then(m => ({ default: m.WorkspacesPage })))
const WorkspaceDetailPage = lazy(() => import('@/pages/WorkspaceDetailPage').then(m => ({ default: m.WorkspaceDetailPage })))
const WorkspaceReviewsPage = lazy(() => import('@/pages/WorkspaceReviewsPage').then(m => ({ default: m.WorkspaceReviewsPage })))
const OntologySchemaPage = lazy(() => import('@/pages/OntologySchemaPage').then(m => ({ default: m.OntologySchemaPage })))
const MyAccessPage = lazy(() => import('@/pages/MyAccessPage').then(m => ({ default: m.MyAccessPage })))
const MyIdentitiesPage = lazy(() => import('@/pages/MyIdentitiesPage').then(m => ({ default: m.MyIdentitiesPage })))

// Auth pages (unauthenticated)
const LoginPage = lazy(() => import('@/components/auth/LoginPage').then(m => ({ default: m.LoginPage })))
const SignUpPage = lazy(() => import('@/components/auth/SignUpPage').then(m => ({ default: m.SignUpPage })))

// Docs (public, self-contained layout)
const DocsPage = lazy(() => import('@/pages/DocsPage').then(m => ({ default: m.DocsPage })))
const DocsContent = lazy(() => import('@/components/docs/DocsContent').then(m => ({ default: m.DocsContent })))
const DocsFAQ = lazy(() => import('@/components/docs/DocsFAQ').then(m => ({ default: m.DocsFAQ })))

// User Guide (public, self-contained premium layout)
const GuidePage = lazy(() => import('@/pages/GuidePage').then(m => ({ default: m.GuidePage })))
const GuideHome = lazy(() => import('@/components/guide/GuideHome').then(m => ({ default: m.GuideHome })))
const GuideContent = lazy(() => import('@/components/guide/GuideContent').then(m => ({ default: m.GuideContent })))
const ForgotPasswordPage = lazy(() => import('@/components/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })))
const ResetPasswordPage = lazy(() => import('@/components/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })))
// Dev-only mock IdP login page. Gated by VITE_AUTH_CUSTOM_PROVIDER_ENABLED
// inside the component (renders a "disabled" banner otherwise).
const DevLogin = lazy(() => import('@/pages/DevLogin').then(m => ({ default: m.DevLogin })))

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
  // Public docs
  {
    path: '/docs',
    element: <Lazy><DocsPage /></Lazy>,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      { path: 'faq', element: <Lazy><DocsFAQ /></Lazy> },
      { path: ':slug', element: <Lazy><DocsContent /></Lazy> },
    ],
  },
  // Public user guide
  {
    path: '/guide',
    element: <Lazy><GuidePage /></Lazy>,
    children: [
      { index: true, element: <Lazy><GuideHome /></Lazy> },
      { path: ':slug', element: <Lazy><GuideContent /></Lazy> },
    ],
  },
  { path: '/forgot-password', element: <Lazy><ForgotPasswordPage /></Lazy> },
  { path: '/reset-password', element: <Lazy><ResetPasswordPage /></Lazy> },
  // Dev/demo mock IdP — gated by VITE_AUTH_CUSTOM_PROVIDER_ENABLED.
  { path: '/dev-login', element: <Lazy><DevLogin /></Lazy> },

  // Authenticated routes (guarded by AppLayout)
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Lazy><Dashboard /></Lazy> },

      // Top-level Ingestion (pipeline control plane: providers, assets, jobs)
      {
        path: 'ingestion',
        element: (
          <RequireNav group="sidebar" sectionKey="ingestion">
            <Lazy><IngestionPage /></Lazy>
          </RequireNav>
        ),
      },
      // Per-data-source overview (owner's home for one catalog item).
      // Reached from the Ingestion → Data Sources list; content self-gates
      // via permission-scoped catalog reads.
      { path: 'datasources/:catalogId', element: <Lazy><DataSourceOverviewPage /></Lazy> },

      // Top-level Workspaces (listing + detail/management). Workspace visuals
      // are view-driven — see /views and /explorer; there is no standalone canvas.
      { path: 'workspaces', element: <Lazy><WorkspacesPage /></Lazy> },
      { path: 'workspaces/:wsId', element: <Lazy><WorkspaceDetailPage /></Lazy> },
      { path: 'workspaces/:wsId/reviews', element: <Lazy><WorkspaceReviewsPage /></Lazy> },

      // Self-service "what can I do?" page — every authenticated user.
      { path: 'my/access', element: <Lazy><MyAccessPage /></Lazy> },
      // SSO identity management — link/unlink IdP connections.
      { path: 'me/identities', element: <Lazy><MyIdentitiesPage /></Lazy> },

      // Schema/Semantic Layer pages — independent of workspace context.
      // They manage global ontology resources and read data source context
      // from URL search params (?workspaceId=X&dataSourceId=Y).
      {
        path: 'schema',
        element: (
          <RequireNav group="sidebar" sectionKey="schema">
            <Lazy><OntologySchemaPage /></Lazy>
          </RequireNav>
        ),
      },
      {
        path: 'schema/:ontologyId',
        element: (
          <RequireNav group="sidebar" sectionKey="schema">
            <Lazy><OntologySchemaPage /></Lazy>
          </RequireNav>
        ),
      },
      // CanvasLayout gates these routes behind a schema fetch so the heavy
      // ontology data only loads when the user navigates to a canvas section.
      {
        element: <CanvasLayout />,
        children: [
          { path: 'explorer', element: <Lazy><ExplorerPage /></Lazy> },
          { path: 'views', element: <Lazy><ViewsGallery /></Lazy> },
          { path: 'views/:viewId', element: <Lazy><ViewPage /></Lazy> },
          { path: 'workspaces/:workspaceId/views', element: <WorkspaceViewsRedirect /> },
        ],
      },
      {
        path: 'admin',
        // Parent guard: any user holding ONE of the admin sub-page
        // permissions can enter. Each sub-route below has its own
        // guard so a delegated admin (e.g. groups-only) lands on the
        // page they have access to and gets an explicit denied panel
        // on routes they don't.
        element: (
          <RequireNav group="sidebar" sectionKey="admin">
            <Lazy><AdminPage /></Lazy>
          </RequireNav>
        ),
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          {
            path: 'overview',
            element: (
              <RequireNav group="admin" sectionKey="overview">
                <Lazy><AdminOverview /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'infrastructure',
            element: (
              <RequireNav group="admin" sectionKey="infrastructure">
                <Lazy><AdminInfrastructure /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'branding',
            element: (
              <RequireNav group="admin" sectionKey="branding">
                <Lazy><AdminBranding /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'features',
            element: (
              <RequireNav group="admin" sectionKey="features">
                <Lazy><AdminFeatures /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'users',
            element: (
              <RequireNav group="admin" sectionKey="users">
                <Lazy><AdminUsers /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'groups',
            element: (
              <RequireNav group="admin" sectionKey="groups">
                <Lazy><AdminGroups /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'permissions',
            element: (
              <RequireNav group="admin" sectionKey="permissions">
                <Lazy><AdminPermissions /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'announcements',
            element: (
              <RequireNav group="admin" sectionKey="announcements">
                <Lazy><AdminAnnouncements /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'sso',
            element: (
              <RequireNav group="admin" sectionKey="sso">
                <Lazy><AdminSso /></Lazy>
              </RequireNav>
            ),
          },
          {
            path: 'audit',
            element: (
              <RequireNav group="admin" sectionKey="audit">
                <Lazy><AdminAudit /></Lazy>
              </RequireNav>
            ),
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
