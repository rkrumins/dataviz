import { Suspense } from 'react'
import { createBrowserRouter, Navigate, useParams } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { CanvasLayout } from '@/components/layout/CanvasLayout'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { RequireNav } from '@/components/auth/RequireNav'
import { RequireAnalytics } from '@/components/auth/RequireAnalytics'
import { RequireFeature } from '@/components/RequireFeature'
import { lazyWithRetry } from '@/lib/lazyWithRetry'
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary'

// The standalone workspace-views page was retired; view management now lives
// in the workspace-detail "Views" tab. Redirect any old link there.
function WorkspaceViewsRedirect() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  return <Navigate to={`/workspaces/${workspaceId}?tab=views`} replace />
}

// Lazy-load all page-level components so their module code and hooks only
// run when the user actually navigates to that route.
const Dashboard = lazyWithRetry(() => import('@/components/dashboard/Dashboard').then(m => ({ default: m.Dashboard })))
const ViewPage = lazyWithRetry(() => import('@/pages/ViewPage').then(m => ({ default: m.ViewPage })))
const ViewsGallery = lazyWithRetry(() => import('@/pages/ViewsGallery').then(m => ({ default: m.ViewsGallery })))
const ExplorerPage = lazyWithRetry(() => import('@/pages/ExplorerPage').then(m => ({ default: m.ExplorerPage })))
const AnalyticsPage = lazyWithRetry(() => import('@/pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })))
const AdminPage = lazyWithRetry(() => import('@/pages/AdminPage').then(m => ({ default: m.AdminPage })))
const AdminOverview = lazyWithRetry(() => import('@/components/admin/AdminOverview').then(m => ({ default: m.AdminOverview })))
const AdminInfrastructure = lazyWithRetry(() => import('@/components/admin/AdminInfrastructure').then(m => ({ default: m.AdminInfrastructure })))
const AdminRedis = lazyWithRetry(() => import('@/components/admin/AdminRedis').then(m => ({ default: m.AdminRedis })))
const AdminBranding = lazyWithRetry(() => import('@/components/admin/AdminBranding').then(m => ({ default: m.AdminBranding })))
const AdminFeatures = lazyWithRetry(() => import('@/components/admin/AdminFeatures/index').then(m => ({ default: m.AdminFeatures })))
const AdminUsers = lazyWithRetry(() => import('@/components/admin/AdminUsers').then(m => ({ default: m.AdminUsers })))
const AdminGroups = lazyWithRetry(() => import('@/components/admin/AdminGroups').then(m => ({ default: m.AdminGroups })))
const AdminPermissions = lazyWithRetry(() => import('@/components/admin/AdminPermissions').then(m => ({ default: m.AdminPermissions })))
const AdminAnnouncements = lazyWithRetry(() => import('@/components/admin/AdminAnnouncements/index').then(m => ({ default: m.AdminAnnouncements })))
const AdminSso = lazyWithRetry(() => import('@/components/admin/AdminSso').then(m => ({ default: m.AdminSso })))
const AdminAudit = lazyWithRetry(() => import('@/components/admin/AdminAudit').then(m => ({ default: m.AdminAudit })))
const AdminTelemetry = lazyWithRetry(() => import('@/components/admin/AdminTelemetry/index').then(m => ({ default: m.AdminTelemetry })))
const IngestionPage = lazyWithRetry(() => import('@/pages/IngestionPage').then(m => ({ default: m.IngestionPage })))
const DataSourceOverviewPage = lazyWithRetry(() => import('@/pages/DataSourceOverviewPage').then(m => ({ default: m.DataSourceOverviewPage })))
const DataSourceHistoryPage = lazyWithRetry(() => import('@/pages/DataSourceHistoryPage').then(m => ({ default: m.DataSourceHistoryPage })))
const WorkspacesPage = lazyWithRetry(() => import('@/pages/WorkspacesPage').then(m => ({ default: m.WorkspacesPage })))
const WorkspaceDetailPage = lazyWithRetry(() => import('@/pages/WorkspaceDetailPage').then(m => ({ default: m.WorkspaceDetailPage })))
const WorkspaceReviewsPage = lazyWithRetry(() => import('@/pages/WorkspaceReviewsPage').then(m => ({ default: m.WorkspaceReviewsPage })))
const OntologySchemaPage = lazyWithRetry(() => import('@/pages/OntologySchemaPage').then(m => ({ default: m.OntologySchemaPage })))
const MyAccessPage = lazyWithRetry(() => import('@/pages/MyAccessPage').then(m => ({ default: m.MyAccessPage })))
const MyIdentitiesPage = lazyWithRetry(() => import('@/pages/MyIdentitiesPage').then(m => ({ default: m.MyIdentitiesPage })))
const AccountSettingsPage = lazyWithRetry(() => import('@/pages/AccountSettingsPage').then(m => ({ default: m.AccountSettingsPage })))
const PasswordChangeRequired = lazyWithRetry(() => import('@/pages/PasswordChangeRequired').then(m => ({ default: m.PasswordChangeRequired })))

// Auth pages (unauthenticated)
const LoginPage = lazyWithRetry(() => import('@/components/auth/LoginPage').then(m => ({ default: m.LoginPage })))
const SignUpPage = lazyWithRetry(() => import('@/components/auth/SignUpPage').then(m => ({ default: m.SignUpPage })))
const InviteAcceptPage = lazyWithRetry(() => import('@/components/auth/InviteAcceptPage').then(m => ({ default: m.InviteAcceptPage })))

// Docs (public, self-contained layout)
const DocsPage = lazyWithRetry(() => import('@/pages/DocsPage').then(m => ({ default: m.DocsPage })))
const DocsHome = lazyWithRetry(() => import('@/components/docs/DocsHome').then(m => ({ default: m.DocsHome })))
const DocsContent = lazyWithRetry(() => import('@/components/docs/DocsContent').then(m => ({ default: m.DocsContent })))
const DocsFAQ = lazyWithRetry(() => import('@/components/docs/DocsFAQ').then(m => ({ default: m.DocsFAQ })))

// User Guide (public, self-contained premium layout)
const GuidePage = lazyWithRetry(() => import('@/pages/GuidePage').then(m => ({ default: m.GuidePage })))
const GuideHome = lazyWithRetry(() => import('@/components/guide/GuideHome').then(m => ({ default: m.GuideHome })))
const GuideContent = lazyWithRetry(() => import('@/components/guide/GuideContent').then(m => ({ default: m.GuideContent })))
const ForgotPasswordPage = lazyWithRetry(() => import('@/components/auth/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })))
const ResetPasswordPage = lazyWithRetry(() => import('@/components/auth/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })))
// Dev-only mock IdP login page. Gated by VITE_AUTH_CUSTOM_PROVIDER_ENABLED
// inside the component (renders a "disabled" banner otherwise).
const DevLogin = lazyWithRetry(() => import('@/pages/DevLogin').then(m => ({ default: m.DevLogin })))

// Landing page for a custom_profile provider whose payload lives in
// browser storage — the backend 302s here from /auth/{slug}/login.
const PortalLogin = lazyWithRetry(() => import('@/pages/PortalLogin').then(m => ({ default: m.PortalLogin })))

// Thin suspense wrapper used for each lazy route — shows a centred spinner.
function PageLoader() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas">
      <div className="w-6 h-6 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

/**
 * Suspense for the pending import, an error boundary for the rejected
 * one. The boundary is the half that was missing: without it a chunk
 * that fails to download unmounts the tree to a blank page, which is how
 * a transient network drop turned into a dead tab.
 *
 * Outside the Suspense on purpose — a boundary nested inside it would be
 * torn down along with the subtree it is meant to catch for.
 */
function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<PageLoader />}>{children}</Suspense>
    </RouteErrorBoundary>
  )
}

export const router = createBrowserRouter([
  // Unauthenticated routes
  { path: '/login', element: <Lazy><LoginPage /></Lazy> },
  // Self-registration is an admin switch AND a security control — but an INVITE is the
  // exception that switch exists to create: turning the open door off is precisely when
  // invites become the only way in, and the server says so (auth.py refuses an uninvited
  // signup while letting an invited one through).
  //
  // RequireFeature cannot express that. It cannot see ?invite=, and it decides from the
  // seeded flag value before the flags have loaded — which sent every invited user to
  // /login and dropped their token on the way. The gate therefore lives INSIDE SignUpPage,
  // the only component that can see both the invite and the load state.
  { path: '/signup', element: <Lazy><SignUpPage /></Lazy> },
  // Where an SSO-redeemed invite lands: the provider handshake proves who
  // they are, this applies what the link carried. Ungated for the same
  // reason /signup is — an invite is the exception the signup switch exists
  // to create, and the server is the enforcement either way.
  { path: '/invite/accept', element: <Lazy><InviteAcceptPage /></Lazy> },
  // Public docs
  {
    path: '/docs',
    element: <Lazy><DocsPage /></Lazy>,
    children: [
      { index: true, element: <Lazy><DocsHome /></Lazy> },
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
  // Sits outside AppLayout on purpose: the API refuses everything but
  // the change form while this is pending, so the app chrome around it
  // would only offer routes that 403.
  { path: '/password-change-required', element: <Lazy><PasswordChangeRequired /></Lazy> },
  // Dev/demo mock IdP — gated by VITE_AUTH_CUSTOM_PROVIDER_ENABLED.
  { path: '/dev-login', element: <Lazy><DevLogin /></Lazy> },
  // Custom-profile SSO landing page (reads the configured storage key).
  { path: '/portal-login', element: <Lazy><PortalLogin /></Lazy> },

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
      // Platform analytics — growth, engagement, and per-workspace insights.
      // Guarded by `RequireAnalytics` rather than `RequireNav`: the door is a
      // permission OR the `analyticsPublicEnabled` flag, and a catalogue spec
      // cannot say "or the flag is on". The guard and the sidebar item read the
      // same hook, so they cannot disagree about who may see it.
      {
        path: 'analytics',
        element: (
          <RequireAnalytics>
            <Lazy><AnalyticsPage /></Lazy>
          </RequireAnalytics>
        ),
      },
      // Per-data-source overview (owner's home for one catalog item).
      // Reached from the Ingestion → Data Sources list; content self-gates
      // via permission-scoped catalog reads.
      { path: 'datasources/:catalogId', element: <Lazy><DataSourceOverviewPage /></Lazy> },
      // Counts over time for that data source. Same gating as the
      // overview above — it self-gates through permission-scoped reads.
      { path: 'datasources/:catalogId/history', element: <Lazy><DataSourceHistoryPage /></Lazy> },

      // Top-level Workspaces (listing + detail/management). Workspace visuals
      // are view-driven — see /views and /explorer; there is no standalone canvas.
      { path: 'workspaces', element: <Lazy><WorkspacesPage /></Lazy> },
      { path: 'workspaces/:wsId', element: <Lazy><WorkspaceDetailPage /></Lazy> },
      // Reviews are a versioning surface — the whole route disappears (redirects
      // to the workspace) when the admin turns version control off.
      { path: 'workspaces/:wsId/reviews', element: <RequireFeature feature="versioningEnabled" explain title="Reviews are turned off" message="Reviews are part of version control, which an administrator hasn't enabled for this deployment. With it on, changes are drafted, reviewed, and merged like a pull request." guideSlug="versioning-change-control"><Lazy><WorkspaceReviewsPage /></Lazy></RequireFeature> },

      // Self-service "what can I do?" page — every authenticated user.
      { path: 'my/access', element: <Lazy><MyAccessPage /></Lazy> },
      // Own profile, password, sessions. Ungated for the same reason as
      // its two siblings: everybody has an account to manage.
      { path: 'me/account', element: <Lazy><AccountSettingsPage /></Lazy> },
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
            path: 'redis',
            element: (
              <RequireNav group="admin" sectionKey="redis">
                <Lazy><AdminRedis /></Lazy>
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
            path: 'telemetry',
            element: (
              <RequireNav group="admin" sectionKey="telemetry">
                <Lazy><AdminTelemetry /></Lazy>
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
