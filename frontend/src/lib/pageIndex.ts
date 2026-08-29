/**
 * Every destination the app-wide palette can send you to, and the rule
 * that decides whether you may see it.
 *
 * Hand-written rather than derived from `routes.tsx`, because a route
 * carries no title, no description and no synonyms — the three things a
 * search needs. The coverage test in `__tests__/pageIndex.test.ts` reads
 * the router source and fails when a route lands here without an entry,
 * which is what keeps the two lists honest.
 *
 * Deliberately dependency-light: literals plus one pure predicate. The
 * copy is duplicated from `SidebarNav`, `AdminPage` and the pages' own
 * tab constants as string literals on purpose — importing those modules
 * would pull lazy admin chunks into the palette's bundle.
 *
 * Deep tabs live in `path` as a `?tab=` query rather than a separate
 * field: every tabbed page validates its own `?tab=` and falls back to
 * its first visible tab, so a link to a tab the reader can't open lands
 * them somewhere sensible instead of nowhere.
 */
import type { NavigationTab } from '@/store/navigation'
import type { NavPermissionSpec } from '@/lib/navPermissions'
import { checkNavPermission, type PermissionClaims } from '@/store/auth'

/**
 * How a destination decides who may see it.
 *
 *   * `always`   — every authenticated user.
 *   * `sidebar`  — the nav catalogue's spec for that top-level tab.
 *   * `admin`    — the sidebar `admin` spec AND the spec for that
 *     `/admin` segment, because the route is nested inside two guards
 *     and passing the inner one is not enough. See `pageAllowed`.
 *   * `analytics`— its own kind because `/analytics` is guarded by
 *     `RequireAnalytics`, which is the catalogue spec OR the
 *     `analyticsPublicEnabled` flag. A spec alone would hide the
 *     section from everyone who gets in through the flag.
 */
export type PageGate =
    | { kind: 'always' }
    | { kind: 'sidebar'; key: NavigationTab }
    | { kind: 'admin'; key: string }
    | { kind: 'analytics' }

export interface PageEntry {
    id: string
    category: 'Page' | 'Setting'
    title: string
    description: string
    /** Words a person might type that the title and description miss. */
    keywords: string[]
    path: string
    gate: PageGate
}

export const PAGE_INDEX: PageEntry[] = [
    // ── Pages ────────────────────────────────────────────────────────
    {
        id: 'dashboard',
        category: 'Page',
        title: 'Dashboard',
        description: 'Overview and workspace activity',
        keywords: ['home', 'start', 'overview', 'activity', 'recent'],
        path: '/dashboard',
        gate: { kind: 'always' },
    },
    {
        id: 'explorer',
        category: 'Page',
        title: 'Explorer',
        description: 'Browse and open saved views',
        keywords: ['explore', 'discover', 'lineage', 'search', 'browse'],
        path: '/explorer',
        gate: { kind: 'sidebar', key: 'explore' },
    },
    {
        // Kept because links and bookmarks still point here; the route
        // redirects to Explorer.
        id: 'views',
        category: 'Page',
        title: 'Views',
        description: 'The saved-views gallery',
        keywords: ['views', 'gallery', 'saved', 'diagrams', 'canvas'],
        path: '/views',
        gate: { kind: 'sidebar', key: 'explore' },
    },
    {
        id: 'workspaces',
        category: 'Page',
        title: 'Workspaces',
        description: 'Manage isolated data environments',
        keywords: ['workspace', 'environments', 'projects', 'teams'],
        path: '/workspaces',
        gate: { kind: 'sidebar', key: 'workspaces' },
    },
    {
        id: 'ingestion',
        category: 'Page',
        title: 'Ingestion',
        description: 'Connect sources and import data',
        keywords: ['import', 'connect', 'load', 'pipeline', 'sources'],
        path: '/ingestion',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'ingestion-providers',
        category: 'Page',
        title: 'Ingestion · Providers',
        description: 'View provider credentials and health',
        keywords: ['providers', 'credentials', 'connections', 'registry'],
        path: '/ingestion?tab=providers',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'ingestion-assets',
        category: 'Page',
        title: 'Ingestion · Data Sources',
        description: 'Register and configure data sources',
        keywords: ['data sources', 'assets', 'catalog', 'register'],
        path: '/ingestion?tab=assets',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'ingestion-jobs',
        category: 'Page',
        title: 'Ingestion · Job History',
        description: 'Aggregation job history and monitoring',
        keywords: ['jobs', 'runs', 'history', 'aggregation', 'monitoring'],
        path: '/ingestion?tab=jobs',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'ingestion-freshness',
        category: 'Page',
        title: 'Ingestion · Freshness',
        description: 'Monitor overlay integrity and source freshness',
        keywords: ['freshness', 'drift', 'reconciliation', 'stale'],
        path: '/ingestion?tab=freshness',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'ingestion-profiling',
        category: 'Page',
        title: 'Ingestion · Profiling',
        description: 'Counts and composition over time',
        keywords: ['profiling', 'counts', 'composition', 'trends'],
        path: '/ingestion?tab=profiling',
        gate: { kind: 'sidebar', key: 'ingestion' },
    },
    {
        id: 'analytics',
        category: 'Page',
        title: 'Analytics',
        description: 'Growth, engagement, and platform insights',
        keywords: ['analytics', 'insights', 'metrics', 'reporting', 'usage'],
        path: '/analytics',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-overview',
        category: 'Page',
        title: 'Analytics · Overview',
        description: 'The headline numbers',
        keywords: ['overview', 'headline', 'summary', 'kpi'],
        path: '/analytics?tab=overview',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-growth',
        category: 'Page',
        title: 'Analytics · Growth',
        description: 'Signups, sources, retention cohorts',
        keywords: ['growth', 'signups', 'retention', 'cohorts'],
        path: '/analytics?tab=growth',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-engagement',
        category: 'Page',
        title: 'Analytics · Engagement',
        description: 'Activity, stickiness, activation funnel',
        keywords: ['engagement', 'activity', 'stickiness', 'activation', 'funnel'],
        path: '/analytics?tab=engagement',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-content',
        category: 'Page',
        title: 'Analytics · Content',
        description: 'Views, visibility and who builds them',
        keywords: ['content', 'views', 'visibility', 'authors'],
        path: '/analytics?tab=content',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-health',
        category: 'Page',
        title: 'Analytics · Health',
        description: 'Freshness, access friction, semantic coverage',
        keywords: ['health', 'freshness', 'friction', 'coverage'],
        path: '/analytics?tab=health',
        gate: { kind: 'analytics' },
    },
    {
        id: 'analytics-workspaces',
        category: 'Page',
        title: 'Analytics · Workspaces',
        description: 'Per-workspace insights and drill-down',
        keywords: ['workspaces', 'per-workspace', 'drill-down'],
        path: '/analytics?tab=workspaces',
        gate: { kind: 'analytics' },
    },
    {
        id: 'schema',
        category: 'Page',
        title: 'Semantic Layers',
        description: 'Define and manage ontology models',
        keywords: ['schema', 'ontology', 'semantic', 'model', 'types', 'entities'],
        path: '/schema',
        gate: { kind: 'sidebar', key: 'schema' },
    },
    {
        id: 'guide',
        category: 'Page',
        title: 'User Guide',
        description: 'Concepts, journeys and walkthroughs for every role',
        keywords: ['guide', 'help', 'how to', 'tutorial', 'learn', 'onboarding'],
        path: '/guide',
        gate: { kind: 'always' },
    },
    {
        id: 'docs',
        category: 'Page',
        title: 'Documentation',
        description: 'Architecture, reference, versioning, security and deployment',
        keywords: ['docs', 'documentation', 'reference', 'api', 'technical'],
        path: '/docs',
        gate: { kind: 'always' },
    },
    {
        id: 'docs-faq',
        category: 'Page',
        title: 'Frequently Asked Questions',
        description: 'Short answers to the questions people ask most',
        keywords: ['faq', 'questions', 'answers', 'help'],
        path: '/docs/faq',
        gate: { kind: 'always' },
    },

    // ── Settings ─────────────────────────────────────────────────────
    {
        id: 'account',
        category: 'Setting',
        title: 'Account settings',
        description: 'Your name, your password, and the devices you are signed in on',
        keywords: ['account', 'profile', 'password', 'sessions', 'devices', 'avatar', 'email'],
        path: '/me/account',
        gate: { kind: 'always' },
    },
    {
        id: 'my-access',
        category: 'Setting',
        title: 'My access',
        description: 'Everything you can do across the platform, and how you got it',
        keywords: ['access', 'permissions', 'roles', 'my access', 'request access'],
        path: '/my/access',
        gate: { kind: 'always' },
    },
    {
        id: 'identities',
        category: 'Setting',
        title: 'Connected identities',
        description: 'The identity providers that can sign you in',
        keywords: ['identities', 'sso', 'idp', 'link', 'sign in', 'login'],
        path: '/me/identities',
        gate: { kind: 'always' },
    },

    // Admin sections. Titles mirror the nav catalogue's labels
    // (`backend/app/services/nav_catalogue.py`) so a search for what the
    // sidebar calls a section finds it.
    {
        id: 'admin-overview',
        category: 'Setting',
        title: 'Global Overview',
        description: 'System health & scale',
        keywords: ['admin', 'overview', 'health', 'scale', 'system'],
        path: '/admin/overview',
        gate: { kind: 'admin', key: 'overview' },
    },
    {
        id: 'admin-infrastructure',
        category: 'Setting',
        title: 'Infrastructure',
        description: 'Service health & data-plane status',
        keywords: ['admin', 'infrastructure', 'services', 'status', 'health'],
        path: '/admin/infrastructure',
        gate: { kind: 'admin', key: 'infrastructure' },
    },
    {
        id: 'admin-redis',
        category: 'Setting',
        title: 'Redis & Graph Store',
        description: 'Streams, cache & default graph endpoints — auth, TLS, provenance',
        keywords: ['admin', 'redis', 'graph', 'streams', 'cache', 'falkordb'],
        path: '/admin/redis',
        gate: { kind: 'admin', key: 'redis' },
    },
    {
        id: 'admin-branding',
        category: 'Setting',
        title: 'Branding',
        description: 'App name, logo & theme',
        keywords: ['admin', 'branding', 'logo', 'theme', 'name', 'white label'],
        path: '/admin/branding',
        gate: { kind: 'admin', key: 'branding' },
    },
    {
        id: 'admin-features',
        category: 'Setting',
        title: 'Features',
        description: 'Feature flags & behaviour',
        keywords: ['admin', 'features', 'flags', 'toggles', 'behaviour'],
        path: '/admin/features',
        gate: { kind: 'admin', key: 'features' },
    },
    {
        id: 'admin-telemetry',
        category: 'Setting',
        title: 'Telemetry',
        description: 'Product usage & content gaps',
        keywords: ['admin', 'telemetry', 'usage', 'tracking', 'gaps'],
        path: '/admin/telemetry',
        gate: { kind: 'admin', key: 'telemetry' },
    },
    {
        id: 'admin-announcements',
        category: 'Setting',
        title: 'Announcements',
        description: 'Global banner messages',
        keywords: ['admin', 'announcements', 'banner', 'message', 'notice'],
        path: '/admin/announcements',
        gate: { kind: 'admin', key: 'announcements' },
    },
    {
        id: 'admin-users',
        category: 'Setting',
        title: 'User Management',
        description: 'Accounts & approvals',
        keywords: ['admin', 'users', 'accounts', 'approvals', 'invite', 'people'],
        path: '/admin/users',
        gate: { kind: 'admin', key: 'users' },
    },
    {
        id: 'admin-groups',
        category: 'Setting',
        title: 'Groups',
        description: 'Bundle members for bulk role grants',
        keywords: ['admin', 'groups', 'members', 'bulk', 'roles'],
        path: '/admin/groups',
        gate: { kind: 'admin', key: 'groups' },
    },
    {
        id: 'admin-permissions',
        category: 'Setting',
        title: 'Permissions',
        description: 'Roles, permissions, and who has access where',
        keywords: ['admin', 'permissions', 'roles', 'rbac', 'grants', 'access'],
        path: '/admin/permissions',
        gate: { kind: 'admin', key: 'permissions' },
    },
    {
        id: 'admin-sso',
        category: 'Setting',
        title: 'SSO',
        description: 'IdP providers + IdP group mappings',
        keywords: ['admin', 'sso', 'saml', 'oidc', 'idp', 'single sign-on'],
        path: '/admin/sso',
        gate: { kind: 'admin', key: 'sso' },
    },
    {
        id: 'admin-audit',
        category: 'Setting',
        title: 'Audit Log',
        description: 'RBAC + user lifecycle history',
        keywords: ['admin', 'audit', 'log', 'history', 'compliance'],
        path: '/admin/audit',
        gate: { kind: 'admin', key: 'audit' },
    },
]

/**
 * What `pageAllowed` needs to answer. The caller supplies the live nav
 * catalogue and the analytics verdict so this stays pure and testable —
 * and so it can be asked for the whole index in one render, which a
 * hook could not be.
 */
export interface PageAccessContext {
    claims: PermissionClaims
    /** `useNavCatalogueStore` sidebar specs, keyed by tab. */
    sidebar: Record<string, NavPermissionSpec>
    /** `useNavCatalogueStore` admin specs, keyed by route segment. */
    adminSections: Record<string, NavPermissionSpec>
    /** `useAnalyticsAccess().allowed` — permission OR the public flag. */
    analyticsAllowed: boolean
}

/**
 * Fail-closed spec for a key the catalogue doesn't carry, mirroring
 * `HIDDEN_SPEC` in `store/navCatalogue.ts`: an unknown section demands a
 * permission nobody holds, so a typo hides a row rather than offering a
 * door that 403s. (A super-admin still passes, exactly as they do
 * through `RequireNav` — the palette must agree with the guard, not be
 * stricter than it.)
 */
const HIDDEN_SPEC: NavPermissionSpec = { kind: 'perm', perm: '__unknown__' }

/** May this reader open this destination? */
export function pageAllowed(entry: PageEntry, ctx: PageAccessContext): boolean {
    switch (entry.gate.kind) {
        case 'always':
            return true
        case 'sidebar':
            return checkNavPermission(ctx.claims, ctx.sidebar[entry.gate.key] ?? HIDDEN_SPEC)
        case 'admin':
            // Two guards, not one. `/admin` is a nested route: the parent
            // is wrapped in <RequireNav group="sidebar" sectionKey="admin">
            // and each section adds its own <RequireNav group="admin" …>.
            // Checking only the section spec offers rows that then render
            // the denied panel at the parent — which is exactly what a
            // holder of `system:audit:read` alone gets for /admin/audit.
            return (
                checkNavPermission(ctx.claims, ctx.sidebar.admin ?? HIDDEN_SPEC) &&
                checkNavPermission(ctx.claims, ctx.adminSections[entry.gate.key] ?? HIDDEN_SPEC)
            )
        case 'analytics':
            return ctx.analyticsAllowed
    }
}
