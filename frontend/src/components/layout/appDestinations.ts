/**
 * appDestinations — the pages the command palette can take you to.
 *
 * The palette knew how to find your workspaces, views, data sources,
 * templates and semantic layers, and then offered exactly two places to
 * navigate: Dashboard and Browse Views, hardcoded. Everything else — the
 * whole admin console, your account, identities, access, ingestion,
 * analytics — was unreachable by name from the one box that claims to
 * search the app. Typing "permissions" found nothing.
 *
 * Gating reuses the nav catalogue's specs, the same ones the route
 * guards read (`RequireNav` → `useSidebarSpec` / `useAdminSectionSpec`),
 * evaluated through `checkNavPermission`. So a destination appears here
 * exactly when the user could actually open it — no second permission
 * model to drift out of step with the first.
 *
 * Ranking reuses `scoreCandidates`, so pages rank against a query the
 * same way workspaces and views do and the groups stay comparable.
 */
import { checkNavPermission, type PermissionClaims } from '@/store/auth'
import type { NavPermissionSpec } from '@/lib/navPermissions'
import { scoreCandidates, type FieldSpec } from '@/utils/searchScoring'


export interface AppDestination {
    id: string
    label: string
    description: string
    path: string
    /** Lucide icon name, rendered via DynamicIcon. */
    icon: string
    /** Words a user might reach for that aren't in the label. */
    keywords: string[]
    /** Which nav-catalogue entry gates this page. Ungated when absent. */
    gate?: { group: 'sidebar' | 'admin'; sectionKey: string }
}


/**
 * Every page a signed-in user can navigate to by name.
 *
 * Parameterised routes (`/views/:id`, `/workspaces/:id`) are deliberately
 * absent — those are *entities*, and the palette already searches them by
 * name through `useGlobalSearch`. This list is the fixed furniture.
 */
export const APP_DESTINATIONS: readonly AppDestination[] = [
    // ── Working surfaces ───────────────────────────────────────────────
    {
        id: 'dashboard', label: 'Dashboard', path: '/dashboard',
        description: 'Your starting point — recent views, templates, activity',
        icon: 'LayoutDashboard',
        keywords: ['home', 'start', 'overview', 'recent'],
    },
    {
        id: 'explorer', label: 'Browse Views', path: '/explorer',
        description: 'Discover and filter every view you can see',
        icon: 'Compass',
        keywords: ['explore', 'gallery', 'discover', 'catalog', 'catalogue'],
    },
    {
        id: 'views', label: 'All Views', path: '/views',
        description: 'The full view gallery',
        icon: 'Eye',
        keywords: ['gallery', 'diagrams', 'canvases'],
    },
    {
        id: 'workspaces', label: 'Workspaces', path: '/workspaces',
        description: 'Workspaces and their connected data sources',
        icon: 'Boxes',
        keywords: ['projects', 'data sources', 'connections', 'catalogs'],
    },
    {
        id: 'schema', label: 'Semantic Layers', path: '/schema',
        description: 'Ontologies, entity types and relationships',
        icon: 'Network',
        keywords: ['ontology', 'schema', 'model', 'entity types', 'taxonomy'],
    },
    {
        id: 'ingestion', label: 'Ingestion', path: '/ingestion',
        description: 'Load and sync metadata from your sources',
        icon: 'DownloadCloud',
        keywords: ['import', 'sync', 'crawl', 'connect', 'pipeline', 'load'],
        gate: { group: 'sidebar', sectionKey: 'ingestion' },
    },
    {
        id: 'analytics', label: 'Analytics', path: '/analytics',
        description: 'Coverage, quality and usage across your estate',
        icon: 'BarChart3',
        keywords: ['insights', 'metrics', 'reports', 'stats', 'quality'],
    },

    // ── Your account ───────────────────────────────────────────────────
    {
        id: 'account', label: 'Account Settings', path: '/me/account',
        description: 'Profile, password, theme and active sessions',
        icon: 'UserCog',
        keywords: ['settings', 'preferences', 'profile', 'password', 'me',
            'theme', 'dark mode', 'sessions', 'security'],
    },
    {
        id: 'identities', label: 'My Sign-in Methods', path: '/me/identities',
        description: 'Linked single sign-on identities',
        icon: 'Link2',
        keywords: ['sso', 'identity', 'login', 'google', 'okta', 'saml', 'oidc'],
    },
    {
        id: 'my-access', label: 'My Access', path: '/my/access',
        description: 'What you can do, and where',
        icon: 'ShieldCheck',
        keywords: ['permissions', 'roles', 'entitlements', 'what can i do'],
    },

    // ── Help ───────────────────────────────────────────────────────────
    {
        id: 'guide', label: 'User Guide', path: '/guide',
        description: 'How-to articles for every part of the product',
        icon: 'BookOpen',
        keywords: ['help', 'docs', 'documentation', 'tutorial', 'learn'],
    },
    {
        id: 'docs', label: 'Reference Docs', path: '/docs',
        description: 'Technical reference and FAQ',
        icon: 'FileText',
        keywords: ['api', 'reference', 'faq', 'technical'],
    },

    // ── Administration ─────────────────────────────────────────────────
    {
        id: 'admin-overview', label: 'Admin Overview', path: '/admin/overview',
        description: 'Deployment health at a glance',
        icon: 'Gauge',
        keywords: ['administration', 'system', 'status'],
        gate: { group: 'admin', sectionKey: 'overview' },
    },
    {
        id: 'admin-users', label: 'Users', path: '/admin/users',
        description: 'Accounts, invitations and sign-in methods',
        icon: 'Users',
        keywords: ['people', 'accounts', 'invite', 'members', 'staff'],
        gate: { group: 'admin', sectionKey: 'users' },
    },
    {
        id: 'admin-groups', label: 'Groups', path: '/admin/groups',
        description: 'Group membership and role assignment',
        icon: 'UsersRound',
        keywords: ['teams', 'membership', 'roles'],
        gate: { group: 'admin', sectionKey: 'groups' },
    },
    {
        id: 'admin-permissions', label: 'Permissions', path: '/admin/permissions',
        description: 'Roles, permissions and who holds them',
        icon: 'ShieldCheck',
        keywords: ['rbac', 'access control', 'roles', 'grants', 'security'],
        gate: { group: 'admin', sectionKey: 'permissions' },
    },
    {
        id: 'admin-sso', label: 'Single Sign-On', path: '/admin/sso',
        description: 'Identity provider connections',
        icon: 'KeyRound',
        keywords: ['saml', 'oidc', 'okta', 'azure', 'entra', 'google',
            'identity provider', 'login'],
        gate: { group: 'admin', sectionKey: 'sso' },
    },
    {
        id: 'admin-branding', label: 'Branding', path: '/admin/branding',
        description: 'Product name, logo and colours',
        icon: 'Palette',
        keywords: ['theme', 'logo', 'white label', 'colours', 'colors', 'name'],
        gate: { group: 'admin', sectionKey: 'branding' },
    },
    {
        id: 'admin-features', label: 'Feature Flags', path: '/admin/features',
        description: 'Turn product capabilities on and off',
        icon: 'ToggleLeft',
        keywords: ['flags', 'toggles', 'capabilities', 'enable', 'disable'],
        gate: { group: 'admin', sectionKey: 'features' },
    },
    {
        id: 'admin-announcements', label: 'Announcements', path: '/admin/announcements',
        description: 'Banners shown to everyone',
        icon: 'Megaphone',
        keywords: ['banner', 'notice', 'broadcast', 'message'],
        gate: { group: 'admin', sectionKey: 'announcements' },
    },
    {
        id: 'admin-audit', label: 'Audit Log', path: '/admin/audit',
        description: 'Who changed what, and when',
        icon: 'ScrollText',
        keywords: ['history', 'log', 'compliance', 'trail', 'events'],
        gate: { group: 'admin', sectionKey: 'audit' },
    },
    {
        id: 'admin-telemetry', label: 'Telemetry', path: '/admin/telemetry',
        description: 'Product usage and diagnostics',
        icon: 'Activity',
        keywords: ['usage', 'metrics', 'diagnostics', 'monitoring'],
        gate: { group: 'admin', sectionKey: 'telemetry' },
    },
    {
        id: 'admin-infrastructure', label: 'Infrastructure', path: '/admin/infrastructure',
        description: 'Graph backend and service health',
        icon: 'Server',
        keywords: ['backend', 'health', 'falkordb', 'graph', 'services'],
        gate: { group: 'admin', sectionKey: 'infrastructure' },
    },
    {
        id: 'admin-redis', label: 'Cache', path: '/admin/redis',
        description: 'Redis cache status and controls',
        icon: 'Database',
        keywords: ['redis', 'cache', 'memory', 'flush'],
        gate: { group: 'admin', sectionKey: 'redis' },
    },
] as const


const FIELDS: FieldSpec<AppDestination>[] = [
    { get: (d) => d.label, weight: 1.0 },
    { get: (d) => d.keywords, weight: 0.7 },
    { get: (d) => d.description, weight: 0.35 },
    { get: (d) => d.path, weight: 0.2 },
]


/**
 * Destinations matching `query` that this user can actually open,
 * ranked. An empty query returns nothing — the palette's zero-search
 * state has its own curated shortcuts.
 */
export function searchDestinations(
    query: string,
    claims: PermissionClaims,
    specs: {
        sidebar: Record<string, NavPermissionSpec>
        admin: Record<string, NavPermissionSpec>
    },
    limit = 6,
): AppDestination[] {
    const q = query.trim()
    if (!q) return []
    const reachable = APP_DESTINATIONS.filter((d) => {
        if (!d.gate) return true
        const spec = d.gate.group === 'sidebar'
            ? specs.sidebar[d.gate.sectionKey]
            : specs.admin[d.gate.sectionKey]
        // Unknown key fails closed — same contract as the route guard's
        // HIDDEN_SPEC fallback. Offering a page that would deny on
        // arrival is worse than not offering it.
        if (!spec) return false
        return checkNavPermission(claims, spec)
    })
    return scoreCandidates(reachable, q, FIELDS).slice(0, limit).map((r) => r.item)
}
