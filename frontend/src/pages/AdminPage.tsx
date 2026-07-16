/**
 * AdminPage — dedicated full-page administration console at /admin.
 * Provides a tabbed left sidebar navigating between:
 *   • Providers — CRUD + health checks
 *   • Workspaces — CRUD + data source management
 *   • Insights — cross-workspace analytics
 */
import { useState } from 'react'
import { NavLink, Outlet, useLocation, Navigate } from 'react-router-dom'
import {
    Activity, BarChart3, Shield, ChevronDown, ToggleLeft, Users, Megaphone,
    UserCog, Users2, KeyRound, Network, History, Palette, Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavPermission } from '@/store/auth'
import { useAdminSectionSpec } from '@/store/navCatalogue'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

// Administration sidebar is split into two sections — "System" for
// platform-wide configuration and "Identity & Access" for the people
// + groups + role-binding surface. The split mirrors every IAM tool
// (Okta, Entra, AWS IAM): operators looking for IAM things expect a
// dedicated section, not items intermingled with feature flags.
//
// Workspaces and data ingestion live as their own top-level sidebar
// destinations (/workspaces, /ingestion) — they're not platform-admin
// concerns.
const adminGroups = [
    {
        id: 'system',
        label: 'System',
        icon: Shield,
        path: '',
        items: [
            { path: 'overview', label: 'Global Overview', icon: BarChart3, description: 'System health & scale' },
            { path: 'infrastructure', label: 'Infrastructure', icon: Activity, description: 'Service health & data-plane status' },
            { path: 'redis', label: 'Redis & Graph Store', icon: Database, description: 'Streams, cache & default graph endpoints — auth, TLS, provenance' },
            { path: 'branding', label: 'Branding', icon: Palette, description: 'App name, logo & theme' },
            { path: 'features', label: 'Features', icon: ToggleLeft, description: 'Feature flags & behaviour' },
            { path: 'announcements', label: 'Announcements', icon: Megaphone, description: 'Global banner messages' },
        ]
    },
    {
        id: 'identity',
        label: 'Identity & Access',
        icon: UserCog,
        path: '',
        items: [
            { path: 'users', label: 'User Management', icon: Users, description: 'Accounts & approvals' },
            { path: 'groups', label: 'Groups', icon: Users2, description: 'Bundle members for bulk role grants' },
            { path: 'permissions', label: 'Permissions', icon: KeyRound, description: 'Roles, permissions, and who has access where' },
            { path: 'sso', label: 'SSO', icon: Network, description: 'IdP providers + IdP group mappings' },
            { path: 'audit', label: 'Audit Log', icon: History, description: 'RBAC + user lifecycle history' },
        ]
    }
]

export function AdminPage() {
    const location = useLocation()
    const brand = useBrand()
    const isRoot = location.pathname === '/admin' || location.pathname === '/admin/'

    // Tab title for every admin sub-page, derived from the same label map that
    // drives the sidebar so the two never drift: "{Section} · Admin · {Brand}".
    const activeSub = location.pathname.replace(/^\/admin\/?/, '').split('/')[0]
    const activeLabel = adminGroups.flatMap(g => g.items).find(i => i.path === activeSub)?.label
    useDocumentTitle(activeLabel ? `${activeLabel} · Admin` : 'Admin')

    // Permission gate per admin sub-item, driven by the centralised nav
    // catalogue served from the backend (seeded by bundled defaults).
    // Hooks called in fixed order; entries the user lacks perms for
    // drop out of the group. ``useAdminSectionSpec`` resolves the live
    // spec from the store.
    const overviewVisible       = useNavPermission(useAdminSectionSpec('overview'))
    const infrastructureVisible = useNavPermission(useAdminSectionSpec('infrastructure'))
    const redisVisible = useNavPermission(useAdminSectionSpec('redis'))
    const brandingVisible      = useNavPermission(useAdminSectionSpec('branding'))
    const featuresVisible      = useNavPermission(useAdminSectionSpec('features'))
    const announcementsVisible = useNavPermission(useAdminSectionSpec('announcements'))
    const usersVisible         = useNavPermission(useAdminSectionSpec('users'))
    const groupsVisible        = useNavPermission(useAdminSectionSpec('groups'))
    const permissionsVisible   = useNavPermission(useAdminSectionSpec('permissions'))
    const ssoVisible           = useNavPermission(useAdminSectionSpec('sso'))
    const auditVisible         = useNavPermission(useAdminSectionSpec('audit'))

    const itemVisibility: Record<string, boolean> = {
        overview:       overviewVisible,
        infrastructure: infrastructureVisible,
        redis:         redisVisible,
        branding:      brandingVisible,
        features:      featuresVisible,
        announcements: announcementsVisible,
        users:         usersVisible,
        groups:        groupsVisible,
        permissions:   permissionsVisible,
        sso:           ssoVisible,
        audit:         auditVisible,
    }

    // Filter items out of each group; drop groups that end up empty.
    const visibleGroups = adminGroups
        .map((g) => ({ ...g, items: g.items.filter((i) => itemVisibility[i.path]) }))
        .filter((g) => g.items.length > 0)

    // Per-group open/close state — pulled OUT of the .map (was a
    // useState inside .map, hooks-order smell). One entry per group
    // id, default open.
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
        () => Object.fromEntries(adminGroups.map((g) => [g.id, true]))
    )
    const toggleGroup = (id: string) =>
        setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }))

    // ── Root-route redirect: send to the first sub-page the user can
    // actually see. A delegated groups admin (no system:admin) lands
    // on /admin/groups instead of bouncing off /admin/overview's
    // access-denied panel.
    if (isRoot) {
        const firstVisible = visibleGroups[0]?.items[0]?.path ?? 'overview'
        return <Navigate to={`/admin/${firstVisible}`} replace />
    }

    return (
        <div className="absolute inset-0 flex bg-canvas">
            {/* Admin Sidebar */}
            <aside className="w-72 shrink-0 border-r border-glass-border bg-canvas-elevated flex flex-col">
                {/* Header */}
                <div className="px-6 pt-6 pb-4">
                    <div className="flex items-center gap-3 mb-1">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                            <Shield className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-lg font-bold text-ink leading-tight">Administration</h1>
                            <p className="text-[11px] text-ink-muted">System configuration</p>
                        </div>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 space-y-4 pt-2">
                    {visibleGroups.map((group) => {
                        const GroupIcon = group.icon
                        // Check if any child is active to keep the group open and highlighted
                        const isGroupActive = group.items.some(item => location.pathname.includes(`/admin/${item.path}`))

                        const isOpen = openGroups[group.id] ?? true

                        return (
                            <div key={group.id} className="space-y-1">
                                {/* Group Header Wrapper */}
                                <div className="flex items-center w-full px-2 py-1.5 rounded-lg group/header hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                                    <NavLink
                                        to={`/admin/${group.path}`}
                                        className={({ isActive }) => cn(
                                            "flex-1 flex items-center gap-2 outline-none rounded-md focus-visible:ring-2 focus-visible:ring-indigo-500/50 p-1",
                                            isActive || isGroupActive ? "text-indigo-500" : "text-ink-muted hover:text-ink-secondary"
                                        )}
                                    >
                                        <GroupIcon className="w-4 h-4 transition-colors" />
                                        <span className="text-xs font-bold uppercase tracking-wider">
                                            {group.label}
                                        </span>
                                    </NavLink>
                                    <button
                                        onClick={(e) => {
                                            e.preventDefault()
                                            toggleGroup(group.id)
                                        }}
                                        className="p-1.5 rounded-md text-ink-muted hover:text-ink-secondary hover:bg-black/10 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                        aria-label="Toggle section"
                                    >
                                        <ChevronDown className={cn(
                                            "w-3.5 h-3.5 transition-transform duration-200",
                                            isOpen ? "" : "-rotate-90"
                                        )} />
                                    </button>
                                </div>

                                {/* Group Items */}
                                <div className={cn(
                                    "grid transition-all duration-200 ease-in-out",
                                    isOpen ? "grid-rows-[1fr] opacity-100 mt-1" : "grid-rows-[0fr] opacity-0 mt-0"
                                )}>
                                    <div className="overflow-hidden space-y-1">
                                        {group.items.map((item) => {
                                            const ItemIcon = item.icon
                                            return (
                                                <NavLink
                                                    key={item.path}
                                                    to={`/admin/${item.path}`}
                                                    className={({ isActive }) => cn(
                                                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left group transition-all duration-200 relative",
                                                        isActive
                                                            ? "bg-gradient-to-r from-indigo-500/10 to-violet-500/10 text-indigo-600 dark:text-indigo-400 shadow-sm border border-indigo-500/20"
                                                            : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink border border-transparent"
                                                    )}
                                                >
                                                    <div className={cn(
                                                        "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                                                        "group-[.active]:bg-indigo-500/20 bg-black/5 dark:bg-white/5"
                                                    )}>
                                                        <ItemIcon className="w-3.5 h-3.5" />
                                                    </div>
                                                    <div className="flex flex-col min-w-0 flex-1">
                                                        <span className="text-sm font-semibold truncate leading-tight">{item.label}</span>
                                                        <span className="text-[10px] text-ink-muted truncate mt-0.5">{item.description}</span>
                                                    </div>
                                                </NavLink>
                                            )
                                        })}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </nav>

                {/* Version tag */}
                <div className="px-6 py-4 border-t border-glass-border">
                    <p className="text-[10px] text-ink-muted text-center">{brand.appName} Admin v1.0</p>
                </div>
            </aside>

            {/* Content Area */}
            <main className="flex-1 overflow-y-auto">
                <Outlet />
            </main>
        </div>
    )
}
