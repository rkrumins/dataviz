/**
 * AdminPermissions — comprehensive RBAC visibility & introspection.
 *
 * Four tabs, each answering a different "who has access to what?"
 * question:
 *
 *   1. **Roles**       — role × permission matrix. Canonical view of
 *                        what each role bundles.
 *   2. **Permissions** — permission catalogue grouped by category;
 *                        clickable for "which roles include this?".
 *   3. **By user**     — subject lens. Pick a user → see effective
 *                        permissions per scope + binding provenance
 *                        (direct vs inherited via group).
 *   4. **By workspace**— scope lens. Pick a workspace → flattened
 *                        member list with role + group attribution.
 *
 * Visual language matches AdminUsers / AdminGroups: gradient hero,
 * KPI strip per tab, framer-motion banners, gradient avatars,
 * sortable tables, custom modals. No Radix Dialog / Tabs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    KeyRound, Shield, UserCog, Eye, Users2, Users, Database, Briefcase,
    RefreshCw, Search, Loader2, AlertCircle, Check, X, Info, Sparkles,
    ChevronRight, GitBranch, Layers, Lock, Zap, BookOpen, Mail,
    Plus, Pencil, Trash2, Globe, AlertTriangle,
} from 'lucide-react'
import {
    permissionsService,
    type PermissionResponse,
    type RoleDefinitionResponse,
    type UserAccessResponse,
    type AccessBinding,
} from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import {
    workspaceMembersService,
    type WorkspaceMemberResponse,
} from '@/services/workspaceMembersService'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import { useToast } from '@/components/ui/toast'
import { avatarGradient, initialsOf } from '@/lib/avatar'
import { cn } from '@/lib/utils'
import { PermissionTooltip } from './PermissionTooltip'


// ── Shared types ─────────────────────────────────────────────────────

type TabKey = 'roles' | 'catalog' | 'byUser' | 'byWorkspace'

interface TabDef {
    key: TabKey
    label: string
    icon: typeof KeyRound
    hint: string
}

const TABS: TabDef[] = [
    { key: 'roles', label: 'Role matrix', icon: GitBranch, hint: 'What does each role bundle?' },
    { key: 'catalog', label: 'Permissions', icon: BookOpen, hint: 'Browse the permission catalogue' },
    { key: 'byUser', label: 'By user', icon: UserCog, hint: 'See everything one user has access to' },
    { key: 'byWorkspace', label: 'By workspace', icon: Layers, hint: 'See who has access to a workspace' },
]


// ── Visual config — roles + categories ──────────────────────────────

const ROLE_VISUAL: Record<string, {
    label: string
    icon: typeof Shield
    accent: string
    badge: string
    gradient: string
    iconBg: string
}> = {
    admin: {
        label: 'Admin',
        icon: Shield,
        accent: 'amber',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        gradient: 'from-amber-500/20 to-amber-500/0',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    user: {
        label: 'User',
        icon: UserCog,
        accent: 'sky',
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        gradient: 'from-sky-500/20 to-sky-500/0',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    viewer: {
        label: 'Viewer',
        icon: Eye,
        accent: 'slate',
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        gradient: 'from-slate-500/20 to-slate-500/0',
        iconBg: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    },
}

// Used for any custom (non-system) role. The icon is overridden to
// ``Sparkles`` at the call-site to mark it visually distinct from
// built-ins.
const CUSTOM_ROLE_VISUAL = {
    label: 'Custom',
    icon: Sparkles,
    accent: 'violet',
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    gradient: 'from-violet-500/20 to-violet-500/0',
    iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
} as const

const CATEGORY_VISUAL: Record<string, {
    label: string
    icon: typeof Lock
    accent: string
    border: string
    pill: string
    description: string
}> = {
    system: {
        label: 'System',
        icon: Lock,
        accent: 'text-violet-600 dark:text-violet-400',
        border: 'border-violet-500/20',
        pill: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
        description: 'Global, platform-wide capabilities',
    },
    workspace: {
        label: 'Workspace',
        icon: Briefcase,
        accent: 'text-indigo-600 dark:text-indigo-400',
        border: 'border-indigo-500/20',
        pill: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
        description: 'Scoped to a single workspace',
    },
    resource: {
        label: 'Resource',
        icon: Zap,
        accent: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-500/20',
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        description: 'Tied to one resource (e.g. a view)',
    },
}


// ── Helpers ──────────────────────────────────────────────────────────

function groupByCategory(perms: PermissionResponse[]): Record<string, PermissionResponse[]> {
    const out: Record<string, PermissionResponse[]> = { system: [], workspace: [], resource: [] }
    for (const p of perms) {
        ;(out[p.category] ??= []).push(p)
    }
    for (const cat of Object.keys(out)) {
        out[cat].sort((a, b) => a.id.localeCompare(b.id))
    }
    return out
}


// ─────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────

export function AdminPermissions() {
    const [tab, setTab] = useState<TabKey>('roles')
    const [permissions, setPermissions] = useState<PermissionResponse[] | null>(null)
    const [roles, setRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [reloading, setReloading] = useState(false)

    // Role-lifecycle state — both modals live at the page level so any
    // tab can summon them and the resulting refresh re-renders the
    // matrix everywhere.
    const [showCreateRole, setShowCreateRole] = useState(false)
    const [editingRole, setEditingRole] = useState<RoleDefinitionResponse | null>(null)

    const fetchCatalogue = useCallback(async () => {
        setReloading(true)
        setLoadError(null)
        try {
            const [p, r] = await Promise.all([
                permissionsService.listPermissions(),
                permissionsService.listRoles(),
            ])
            setPermissions(p)
            setRoles(r)
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Failed to load')
        } finally {
            setReloading(false)
        }
    }, [])

    useEffect(() => { void fetchCatalogue() }, [fetchCatalogue])


    return (
        <div className="max-w-7xl mx-auto p-8 animate-in fade-in duration-500">
            {/* Hero */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-md">
                        <KeyRound className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink">Permissions</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            See exactly what each role grants — and who has access where.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {tab === 'roles' && (
                        <button
                            onClick={() => setShowCreateRole(true)}
                            className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                        >
                            <Plus className="w-4 h-4" />
                            New role
                        </button>
                    )}
                    <button
                        onClick={() => void fetchCatalogue()}
                        disabled={reloading}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-4 h-4', reloading && 'animate-spin')} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-glass-border mb-6">
                {TABS.map(t => {
                    const Icon = t.icon
                    const isActive = tab === t.key
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            title={t.hint}
                            className={cn(
                                'flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-colors duration-150 border-b-2',
                                isActive
                                    ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                                    : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl',
                            )}
                        >
                            <Icon className="w-4 h-4" />
                            {t.label}
                        </button>
                    )
                })}
            </div>

            {/* Load error */}
            <AnimatePresence>
                {loadError && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm"
                    >
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <p className="flex-1">{loadError}</p>
                        <button onClick={() => setLoadError(null)} className="p-1 rounded-lg hover:bg-red-500/10">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Loading state */}
            {(permissions === null || roles === null) && !loadError ? (
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                </div>
            ) : (
                <>
                    {permissions && roles && tab === 'roles' && (
                        <RoleMatrixTab
                            permissions={permissions}
                            roles={roles}
                            onEditRole={setEditingRole}
                            onPermissionUpdated={() => void fetchCatalogue()}
                        />
                    )}
                    {permissions && roles && tab === 'catalog' && (
                        <PermissionCatalogTab permissions={permissions} roles={roles} />
                    )}
                    {permissions && tab === 'byUser' && (
                        <ByUserTab permissions={permissions} />
                    )}
                    {tab === 'byWorkspace' && <ByWorkspaceTab />}
                </>
            )}

            {/* Role lifecycle modals (visible from any tab) */}
            <AnimatePresence>
                {showCreateRole && permissions && (
                    <CreateRoleModal
                        permissions={permissions}
                        existingNames={(roles ?? []).map(r => r.name)}
                        onClose={() => setShowCreateRole(false)}
                        onCreated={async () => {
                            setShowCreateRole(false)
                            await fetchCatalogue()
                        }}
                    />
                )}
                {editingRole && permissions && (
                    <RoleEditorDrawer
                        role={editingRole}
                        permissions={permissions}
                        onClose={() => setEditingRole(null)}
                        onChanged={async () => {
                            setEditingRole(null)
                            await fetchCatalogue()
                        }}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Tab 1 — Role matrix
// ─────────────────────────────────────────────────────────────────────

function RoleMatrixTab({
    permissions, roles, onEditRole, onPermissionUpdated,
}: {
    permissions: PermissionResponse[]
    roles: RoleDefinitionResponse[]
    onEditRole: (role: RoleDefinitionResponse) => void
    onPermissionUpdated: () => void
}) {
    const [selectedPerm, setSelectedPerm] = useState<PermissionResponse | null>(null)
    const [hoverPermId, setHoverPermId] = useState<string | null>(null)

    // Build permission lookup: { roleName → Set<permId> }
    const rolePerms = useMemo(() => {
        const out: Record<string, Set<string>> = {}
        for (const r of roles) out[r.name] = new Set(r.permissions)
        return out
    }, [roles])

    const grouped = useMemo(() => groupByCategory(permissions), [permissions])

    const kpis = useMemo(() => ({
        roles: roles.length,
        custom: roles.filter(r => !r.isSystem).length,
        permissions: permissions.length,
        scoped: roles.filter(r => r.scopeType === 'workspace').length,
    }), [roles, permissions])

    const KPIS = [
        { key: 'roles', label: 'Roles', value: kpis.roles, icon: Shield, gradient: 'from-amber-500/20 to-amber-500/0', accent: 'text-amber-600 dark:text-amber-400', iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
        { key: 'custom', label: 'Custom roles', value: kpis.custom, icon: Sparkles, gradient: 'from-violet-500/20 to-violet-500/0', accent: 'text-violet-600 dark:text-violet-400', iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20' },
        { key: 'permissions', label: 'Permissions', value: kpis.permissions, icon: KeyRound, gradient: 'from-emerald-500/20 to-emerald-500/0', accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
        { key: 'scoped', label: 'Workspace-scoped', value: kpis.scoped, icon: Briefcase, gradient: 'from-indigo-500/20 to-indigo-500/0', accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
    ] as const

    return (
        <div className="space-y-5">
            {/* KPI strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {KPIS.map(kpi => {
                    const Icon = kpi.icon
                    return (
                        <div
                            key={kpi.key}
                            className="relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated"
                        >
                            <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', kpi.gradient)} />
                            <div className="relative">
                                <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center mb-3', kpi.iconBg)}>
                                    <Icon className="w-4.5 h-4.5" />
                                </div>
                                <p className={cn('text-2xl font-bold', kpi.accent)}>{kpi.value}</p>
                                <p className="text-xs text-ink-muted mt-1">{kpi.label}</p>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Matrix */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-black/[0.03] dark:bg-white/[0.03] border-b border-glass-border">
                                <th className="text-left px-5 py-3 sticky left-0 z-10 bg-black/[0.03] dark:bg-[#161616]">
                                    <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                                        Permission
                                    </span>
                                </th>
                                {roles.map(r => {
                                    const v = ROLE_VISUAL[r.name] ?? CUSTOM_ROLE_VISUAL
                                    const RoleIcon = r.isSystem ? v.icon : Sparkles
                                    const labelText = r.isSystem
                                        ? v.label
                                        : r.name
                                    const isWsScoped = r.scopeType === 'workspace'
                                    return (
                                        <th key={r.name} className="px-3 py-3 min-w-[120px] align-top">
                                            <button
                                                onClick={() => onEditRole(r)}
                                                title={r.isSystem
                                                    ? `${labelText} — system role (read-only)`
                                                    : `Edit ${labelText}`}
                                                className="w-full flex flex-col items-center gap-1 px-1 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors group"
                                            >
                                                <div className="relative">
                                                    <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center', v.iconBg)}>
                                                        <RoleIcon className="w-4 h-4" />
                                                    </div>
                                                    {r.isSystem ? (
                                                        <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-canvas-elevated border border-glass-border flex items-center justify-center" title="System role">
                                                            <Lock className="w-2.5 h-2.5 text-ink-muted" />
                                                        </span>
                                                    ) : (
                                                        <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-canvas-elevated border border-glass-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" title="Edit">
                                                            <Pencil className="w-2.5 h-2.5 text-ink-muted" />
                                                        </span>
                                                    )}
                                                </div>
                                                <span className={cn(
                                                    'text-xs font-bold uppercase tracking-wider truncate max-w-[100px]',
                                                    r.isSystem ? 'text-ink' : 'text-violet-600 dark:text-violet-400',
                                                )}>
                                                    {labelText}
                                                </span>
                                                {/* Scope chip */}
                                                <span className={cn(
                                                    'inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[9px] font-semibold border',
                                                    isWsScoped
                                                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
                                                        : 'bg-glass-base/40 text-ink-muted border-glass-border',
                                                )}>
                                                    {isWsScoped ? (
                                                        <><Briefcase className="w-2 h-2" />ws</>
                                                    ) : (
                                                        <><Globe className="w-2 h-2" />global</>
                                                    )}
                                                </span>
                                                <span className="text-[10px] text-ink-muted">
                                                    {r.permissions.length} perm{r.permissions.length !== 1 ? 's' : ''}
                                                </span>
                                            </button>
                                        </th>
                                    )
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            {(['system', 'workspace', 'resource'] as const).map(cat => {
                                const list = grouped[cat] ?? []
                                if (list.length === 0) return null
                                const catv = CATEGORY_VISUAL[cat]
                                const CatIcon = catv.icon
                                return (
                                    <>
                                        {/* Category divider row */}
                                        <tr key={`cat-${cat}`} className="bg-glass-base/30 border-y border-glass-border">
                                            <td colSpan={1 + roles.length} className="px-5 py-2">
                                                <div className="flex items-center gap-2">
                                                    <CatIcon className={cn('w-3.5 h-3.5', catv.accent)} />
                                                    <span className={cn('text-[11px] font-bold uppercase tracking-wider', catv.accent)}>
                                                        {catv.label}
                                                    </span>
                                                    <span className="text-[10px] text-ink-muted">— {catv.description}</span>
                                                </div>
                                            </td>
                                        </tr>
                                        {list.map((p, i) => {
                                            const isHovered = hoverPermId === p.id
                                            return (
                                                <tr
                                                    key={p.id}
                                                    onMouseEnter={() => setHoverPermId(p.id)}
                                                    onMouseLeave={() => setHoverPermId(null)}
                                                    onClick={() => setSelectedPerm(p)}
                                                    className={cn(
                                                        'border-b last:border-b-0 border-glass-border transition-colors cursor-pointer',
                                                        isHovered
                                                            ? 'bg-emerald-500/[0.04]'
                                                            : i % 2 === 0
                                                                ? 'bg-transparent'
                                                                : 'bg-black/[0.015] dark:bg-white/[0.015]',
                                                    )}
                                                >
                                                    {/* Permission cell */}
                                                    <td className="px-5 py-2.5 sticky left-0 z-10 bg-canvas-elevated">
                                                        <div className="flex flex-col gap-0.5 min-w-0">
                                                            <div className="flex items-center gap-1.5 min-w-0">
                                                                <code className="text-xs font-mono font-semibold text-ink truncate">
                                                                    {p.id}
                                                                </code>
                                                                <PermissionTooltip
                                                                    permission={p}
                                                                    grantedToRoles={roles
                                                                        .filter(r => rolePerms[r.name]?.has(p.id))
                                                                        .map(r => r.isSystem ? r.name : r.name)}
                                                                    placement="right"
                                                                />
                                                            </div>
                                                            <span className="text-[11px] text-ink-muted truncate">
                                                                {p.description}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    {/* Role cells */}
                                                    {roles.map(r => {
                                                        const has = rolePerms[r.name]?.has(p.id) ?? false
                                                        const v = ROLE_VISUAL[r.name] ?? CUSTOM_ROLE_VISUAL
                                                        return (
                                                            <td key={r.name} className="px-3 py-2.5 text-center">
                                                                {has ? (
                                                                    <div className={cn(
                                                                        'inline-flex items-center justify-center w-6 h-6 rounded-full border',
                                                                        v.iconBg,
                                                                    )}>
                                                                        <Check className="w-3 h-3" />
                                                                    </div>
                                                                ) : (
                                                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-ink-muted/20" />
                                                                )}
                                                            </td>
                                                        )
                                                    })}
                                                </tr>
                                            )
                                        })}
                                    </>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center gap-3">
                    <Info className="w-3.5 h-3.5 text-ink-muted" />
                    <p className="text-xs text-ink-muted">
                        Click any permission row to see its full details. ✓ means the role bundles that permission.
                    </p>
                </div>
            </div>

            {/* Permission detail drawer */}
            <AnimatePresence>
                {selectedPerm && (
                    <PermissionDetailDrawer
                        permission={selectedPerm}
                        roles={roles}
                        onClose={() => setSelectedPerm(null)}
                        onUpdated={(updated) => {
                            setSelectedPerm(updated)
                            onPermissionUpdated()
                        }}
                    />
                )}
            </AnimatePresence>
        </div>
    )
}


function PermissionDetailDrawer({
    permission, roles, onClose, onUpdated,
}: {
    permission: PermissionResponse
    roles: RoleDefinitionResponse[]
    onClose: () => void
    onUpdated: (updated: PermissionResponse) => void
}) {
    const grantedTo = roles.filter(r => r.permissions.includes(permission.id))
    const cv = CATEGORY_VISUAL[permission.category] ?? CATEGORY_VISUAL.system
    const CatIcon = cv.icon

    // ── Edit mode state ──────────────────────────────────────────
    const [editing, setEditing] = useState(false)
    const [editDescription, setEditDescription] = useState(permission.description)
    const [editLong, setEditLong] = useState(permission.longDescription ?? '')
    const [editExamples, setEditExamples] = useState((permission.examples ?? []).join('\n'))
    const [saving, setSaving] = useState(false)
    const { showToast } = useToast()

    const startEdit = () => {
        setEditDescription(permission.description)
        setEditLong(permission.longDescription ?? '')
        setEditExamples((permission.examples ?? []).join('\n'))
        setEditing(true)
    }

    const cancelEdit = () => setEditing(false)

    const handleSave = async () => {
        const trimmed = editDescription.trim()
        if (!trimmed) {
            showToast('error', 'Short description is required.')
            return
        }
        setSaving(true)
        try {
            const examples = editExamples
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean)
            const updated = await permissionsService.updatePermission(permission.id, {
                description: trimmed,
                longDescription: editLong.trim() || '',
                examples,
            })
            showToast('success', `Updated ${permission.id}`)
            setEditing(false)
            onUpdated(updated)
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
            <div className="absolute inset-0 bg-black/50" onClick={onClose} />
            <motion.div
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-md p-6"
            >
                <div className="flex items-start justify-between mb-4 gap-2">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center shrink-0', cv.pill)}>
                            <CatIcon className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <code className="text-sm font-mono font-bold text-ink break-all">{permission.id}</code>
                            <p className="text-xs text-ink-muted mt-0.5">{permission.description}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {!editing && (
                            <button
                                onClick={startEdit}
                                title="Edit description and examples"
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink bg-glass-base/40 border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <Pencil className="w-3 h-3" />
                                Edit
                            </button>
                        )}
                        <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="space-y-4">
                    {editing ? (
                        <>
                            {/* Edit mode: short description */}
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                    Short description <span className="text-red-500 normal-case font-normal">required</span>
                                </label>
                                <input
                                    value={editDescription}
                                    onChange={(e) => setEditDescription(e.target.value)}
                                    placeholder="One-line summary"
                                    className="input w-full text-sm"
                                    disabled={saving}
                                />
                                <p className="text-[10px] text-ink-muted mt-1">
                                    Shown next to the permission id in tables and pickers.
                                </p>
                            </div>

                            {/* Edit mode: long description */}
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                    What this allows
                                </label>
                                <textarea
                                    value={editLong}
                                    onChange={(e) => setEditLong(e.target.value)}
                                    placeholder="Paragraph explaining what this permission lets a user do, including any caveats or related permissions."
                                    rows={4}
                                    className="input w-full text-sm resize-none"
                                    disabled={saving}
                                />
                                <p className="text-[10px] text-ink-muted mt-1">
                                    Surfaced in the hover tooltip. Leave blank to fall back to the short description.
                                </p>
                            </div>

                            {/* Edit mode: examples (one per line) */}
                            <div>
                                <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3 text-emerald-500" />
                                    Example actions
                                </label>
                                <textarea
                                    value={editExamples}
                                    onChange={(e) => setEditExamples(e.target.value)}
                                    placeholder={'One example per line. e.g.\nEdit any view in the workspace\nRename a view someone else created'}
                                    rows={5}
                                    className="input w-full text-sm font-mono resize-none"
                                    disabled={saving}
                                />
                                <p className="text-[10px] text-ink-muted mt-1">
                                    One bullet per line. Empty lines are ignored.
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Read mode: long-form explanation. Falls back to
                                the short description for permissions that pre-date
                                the backfill. */}
                            <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                                    What this allows
                                </h4>
                                <p className="text-sm text-ink-secondary leading-relaxed">
                                    {permission.longDescription ?? permission.description}
                                </p>
                            </div>

                            {/* Read mode: concrete example actions */}
                            {permission.examples.length > 0 && (
                                <div>
                                    <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 flex items-center gap-1">
                                        <Sparkles className="w-3 h-3 text-emerald-500" />
                                        Example actions
                                    </h4>
                                    <ul className="space-y-1.5 rounded-xl border border-glass-border bg-glass-base/30 p-3">
                                        {permission.examples.map((ex, i) => (
                                            <li key={i} className="text-xs text-ink-secondary leading-relaxed flex items-start gap-2">
                                                <span className="text-emerald-500 shrink-0 mt-px">•</span>
                                                <span className="min-w-0">{ex}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}

                    <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                            Category
                        </h4>
                        <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border', cv.pill)}>
                            <CatIcon className="w-3 h-3" />
                            {cv.label}
                        </span>
                        <p className="text-[11px] text-ink-muted mt-1.5">{cv.description}</p>
                    </div>

                    <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                            Granted to {grantedTo.length} role{grantedTo.length !== 1 ? 's' : ''}
                        </h4>
                        {grantedTo.length === 0 ? (
                            <p className="text-xs text-ink-muted italic">
                                No built-in role currently bundles this permission.
                            </p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {grantedTo.map(r => {
                                    const v = ROLE_VISUAL[r.name] ?? ROLE_VISUAL.user
                                    const RoleIcon = v.icon
                                    return (
                                        <span
                                            key={r.name}
                                            className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border', v.badge)}
                                        >
                                            <RoleIcon className="w-3 h-3" />
                                            {v.label}
                                        </span>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Edit-mode footer */}
                {editing && (
                    <div className="mt-5 pt-4 border-t border-glass-border flex items-center justify-end gap-2">
                        <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => void handleSave()}
                            disabled={saving || !editDescription.trim()}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm shadow-accent-lineage/20"
                        >
                            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                            Save changes
                        </button>
                    </div>
                )}
            </motion.div>
        </motion.div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Tab 2 — Permissions catalogue
// ─────────────────────────────────────────────────────────────────────

function PermissionCatalogTab({
    permissions, roles,
}: {
    permissions: PermissionResponse[]
    roles: RoleDefinitionResponse[]
}) {
    const [search, setSearch] = useState('')
    const [activeCategory, setActiveCategory] = useState<'all' | 'system' | 'workspace' | 'resource'>('all')

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        return permissions.filter(p => {
            if (activeCategory !== 'all' && p.category !== activeCategory) return false
            if (!q) return true
            return p.id.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
        })
    }, [permissions, activeCategory, search])

    const grouped = useMemo(() => groupByCategory(filtered), [filtered])

    const categoryCounts = useMemo(() => ({
        all: permissions.length,
        system: permissions.filter(p => p.category === 'system').length,
        workspace: permissions.filter(p => p.category === 'workspace').length,
        resource: permissions.filter(p => p.category === 'resource').length,
    }), [permissions])

    const rolesContainingPerm = useMemo(() => {
        const out: Record<string, string[]> = {}
        for (const p of permissions) out[p.id] = []
        for (const r of roles) {
            for (const id of r.permissions) {
                ;(out[id] ??= []).push(r.name)
            }
        }
        return out
    }, [permissions, roles])

    return (
        <div className="space-y-5">
            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap">
                <div className="flex gap-1 bg-black/5 dark:bg-white/5 rounded-xl p-1">
                    {([
                        { key: 'all' as const, label: 'All' },
                        { key: 'system' as const, label: 'System' },
                        { key: 'workspace' as const, label: 'Workspace' },
                        { key: 'resource' as const, label: 'Resource' },
                    ]).map(t => {
                        const isActive = activeCategory === t.key
                        const count = categoryCounts[t.key]
                        return (
                            <button
                                key={t.key}
                                onClick={() => setActiveCategory(t.key)}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                                    isActive ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                                )}
                            >
                                {t.label}
                                <span className={cn(
                                    'ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none',
                                    isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-black/5 dark:bg-white/10 text-ink-muted',
                                )}>{count}</span>
                            </button>
                        )
                    })}
                </div>
                <div className="relative flex-1 max-w-xs ml-auto">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        type="text"
                        placeholder="Search permissions..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="input pl-9 h-9 text-sm bg-white/50 dark:bg-black/20 w-full"
                    />
                    {search && (
                        <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Empty state */}
            {filtered.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated py-16 flex flex-col items-center justify-center">
                    <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-3">
                        <Search className="w-7 h-7 text-ink-muted/60" />
                    </div>
                    <p className="text-sm font-medium text-ink-secondary">No permissions match</p>
                    <p className="text-xs text-ink-muted mt-1">Try a different category or search query.</p>
                </div>
            ) : (
                /* Cards grouped by category */
                <div className="space-y-6">
                    {(['system', 'workspace', 'resource'] as const).map(cat => {
                        const list = grouped[cat] ?? []
                        if (list.length === 0) return null
                        const cv = CATEGORY_VISUAL[cat]
                        const CatIcon = cv.icon
                        return (
                            <section key={cat}>
                                <div className="flex items-center gap-2 mb-3">
                                    <div className={cn('w-7 h-7 rounded-lg border flex items-center justify-center', cv.pill)}>
                                        <CatIcon className="w-3.5 h-3.5" />
                                    </div>
                                    <h3 className={cn('text-sm font-bold uppercase tracking-wider', cv.accent)}>
                                        {cv.label}
                                    </h3>
                                    <span className="text-[10px] text-ink-muted">— {cv.description}</span>
                                    <span className="ml-auto text-xs text-ink-muted">{list.length}</span>
                                </div>
                                <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
                                    {list.map(p => {
                                        const inRoles = rolesContainingPerm[p.id] ?? []
                                        return (
                                            <div
                                                key={p.id}
                                                className={cn(
                                                    'group rounded-xl border bg-canvas-elevated p-4 hover:shadow-md transition-shadow',
                                                    cv.border,
                                                )}
                                            >
                                                <div className="flex items-start gap-3 mb-3">
                                                    <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', cv.pill)}>
                                                        <CatIcon className="w-4 h-4" />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <code className="block text-sm font-mono font-bold text-ink truncate">
                                                                {p.id}
                                                            </code>
                                                            <PermissionTooltip
                                                                permission={p}
                                                                grantedToRoles={inRoles}
                                                                placement="below"
                                                                size="md"
                                                            />
                                                        </div>
                                                        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{p.description}</p>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-glass-border">
                                                    <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
                                                        Granted to
                                                    </span>
                                                    {inRoles.length === 0 ? (
                                                        <span className="text-[11px] italic text-ink-muted">No role</span>
                                                    ) : (
                                                        inRoles.map(rname => {
                                                            const v = ROLE_VISUAL[rname] ?? ROLE_VISUAL.user
                                                            const RoleIcon = v.icon
                                                            return (
                                                                <span
                                                                    key={rname}
                                                                    className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border', v.badge)}
                                                                >
                                                                    <RoleIcon className="w-2.5 h-2.5" />
                                                                    {v.label}
                                                                </span>
                                                            )
                                                        })
                                                    )}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </section>
                        )
                    })}
                </div>
            )}
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Tab 3 — By user (subject lens)
// ─────────────────────────────────────────────────────────────────────

function ByUserTab({ permissions: _permissions }: { permissions: PermissionResponse[] }) {
    void _permissions
    const [users, setUsers] = useState<AdminUserResponse[] | null>(null)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [access, setAccess] = useState<UserAccessResponse | null>(null)
    const [loadingAccess, setLoadingAccess] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { showToast } = useToast()

    // Initial user list
    useEffect(() => {
        ;(async () => {
            try {
                setUsers(await adminUserService.listUsers())
            } catch (err) {
                showToast('error', err instanceof Error ? err.message : 'Failed to load users')
            }
        })()
    }, [showToast])

    // Fetch selected user's access
    useEffect(() => {
        if (!selectedId) { setAccess(null); return }
        setLoadingAccess(true)
        setError(null)
        ;(async () => {
            try {
                const data = await permissionsService.getUserAccess(selectedId)
                setAccess(data)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load access')
                setAccess(null)
            } finally {
                setLoadingAccess(false)
            }
        })()
    }, [selectedId])

    const filteredUsers = useMemo(() => {
        if (!users) return []
        const q = search.trim().toLowerCase()
        return users
            .filter(u => !q || u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
    }, [users, search])

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5 min-h-[60vh]">
            {/* Left pane — user picker */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden flex flex-col">
                <div className="p-3 border-b border-glass-border">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                        <input
                            type="text"
                            placeholder="Search users..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="input pl-9 h-9 text-sm bg-glass-base/40 w-full"
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {users === null ? (
                        <div className="p-8 text-center text-ink-muted text-sm">
                            <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                            Loading…
                        </div>
                    ) : filteredUsers.length === 0 ? (
                        <div className="p-8 text-center text-ink-muted text-sm">No matching users.</div>
                    ) : (
                        filteredUsers.map(u => {
                            const isSel = selectedId === u.id
                            return (
                                <button
                                    key={u.id}
                                    onClick={() => setSelectedId(u.id)}
                                    className={cn(
                                        'w-full flex items-center gap-2.5 px-3 py-2.5 border-b last:border-b-0 border-glass-border text-left transition-colors',
                                        isSel ? 'bg-emerald-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                    )}
                                >
                                    <div className={cn(
                                        'w-8 h-8 rounded-full bg-gradient-to-br flex items-center justify-center text-[11px] font-bold text-white shrink-0',
                                        avatarGradient(u.displayName),
                                    )}>
                                        {initialsOf(u.displayName)}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className={cn('text-sm truncate', isSel ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-ink')}>
                                            {u.displayName}
                                        </p>
                                        <p className="text-[11px] text-ink-muted truncate">{u.email}</p>
                                    </div>
                                    {isSel && <ChevronRight className="w-4 h-4 text-emerald-500 shrink-0" />}
                                </button>
                            )
                        })
                    )}
                </div>
            </div>

            {/* Right pane — access detail */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden flex flex-col">
                {!selectedId ? (
                    <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                            <UserCog className="w-7 h-7 text-emerald-500" />
                        </div>
                        <p className="text-sm font-semibold text-ink mb-1">Pick a user to inspect</p>
                        <p className="text-xs text-ink-muted max-w-sm">
                            See every binding the user holds — direct or via a group — and the resulting effective permissions.
                        </p>
                    </div>
                ) : loadingAccess || !access ? (
                    error ? (
                        <div className="p-8 text-center text-red-500 text-sm">{error}</div>
                    ) : (
                        <div className="flex items-center justify-center flex-1">
                            <Loader2 className="w-5 h-5 animate-spin text-ink-muted" />
                        </div>
                    )
                ) : (
                    <UserAccessDetail access={access} />
                )}
            </div>
        </div>
    )
}


function UserAccessDetail({ access }: { access: UserAccessResponse }) {
    const totalBindings = access.directBindings.length + access.inheritedBindings.length
    const wsCount = Object.keys(access.effectiveWs).length
    const isAdmin = access.effectiveGlobal.includes('system:admin')

    // Group inherited bindings by group for cleaner display.
    const byGroup = useMemo(() => {
        const out: Record<string, AccessBinding[]> = {}
        for (const b of access.inheritedBindings) {
            const g = b.viaGroup
            if (!g) continue
            ;(out[g.id] ??= []).push(b)
        }
        return out
    }, [access.inheritedBindings])

    return (
        <div className="overflow-y-auto p-6 space-y-6">
            {/* User header */}
            <div className="flex items-start gap-4">
                <div className={cn(
                    'w-14 h-14 rounded-2xl bg-gradient-to-br flex items-center justify-center text-base font-bold text-white shrink-0 shadow-md',
                    avatarGradient(access.user.displayName),
                )}>
                    {initialsOf(access.user.displayName)}
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold text-ink truncate">{access.user.displayName}</h2>
                    <div className="flex items-center gap-1 mt-0.5">
                        <Mail className="w-3.5 h-3.5 text-ink-muted" />
                        <p className="text-sm text-ink-muted truncate">{access.user.email}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                        {isAdmin && (
                            <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border', ROLE_VISUAL.admin.badge)}>
                                <Shield className="w-3 h-3" />
                                System admin
                            </span>
                        )}
                        <span className={cn(
                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border',
                            access.user.status === 'active'
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
                        )}>
                            <span className={cn('w-1.5 h-1.5 rounded-full', access.user.status === 'active' ? 'bg-emerald-500' : 'bg-amber-500')} />
                            {access.user.status}
                        </span>
                    </div>
                </div>
            </div>

            {/* Mini KPI strip */}
            <div className="grid grid-cols-3 gap-3">
                <KpiTile label="Total bindings" value={totalBindings} icon={GitBranch} accent="emerald" />
                <KpiTile label="Workspaces reached" value={wsCount} icon={Briefcase} accent="indigo" />
                <KpiTile label="Group memberships" value={access.groups.length} icon={Users2} accent="violet" />
            </div>

            {/* Effective permissions */}
            <Section
                title="Effective access"
                hint="What this user can actually do, after merging direct + group bindings."
                icon={Sparkles}
                accent="emerald"
            >
                {access.effectiveGlobal.length === 0 && Object.keys(access.effectiveWs).length === 0 && !isAdmin ? (
                    <EmptyHint icon={Lock} text="No effective permissions — the user can't access anything until granted a binding." />
                ) : (
                    <div className="space-y-3">
                        {/* Global */}
                        {access.effectiveGlobal.length > 0 && (
                            <ScopeCard
                                scopeIcon={Lock}
                                scopeLabel="Global"
                                scopeSublabel="System-wide permissions"
                                accent="violet"
                                permissions={access.effectiveGlobal}
                            />
                        )}
                        {/* Per-workspace */}
                        {Object.entries(access.effectiveWs).map(([wsId, perms]) => (
                            <ScopeCard
                                key={wsId}
                                scopeIcon={Briefcase}
                                scopeLabel={wsId}
                                scopeSublabel="Workspace permissions"
                                accent="indigo"
                                permissions={perms}
                            />
                        ))}
                    </div>
                )}
            </Section>

            {/* Direct bindings */}
            <Section
                title="Direct bindings"
                hint="Bindings attached to the user directly — independent of group membership."
                icon={UserCog}
                accent="sky"
                count={access.directBindings.length}
            >
                {access.directBindings.length === 0 ? (
                    <EmptyHint icon={UserCog} text="No direct bindings. All access comes via group membership." />
                ) : (
                    <BindingList bindings={access.directBindings} />
                )}
            </Section>

            {/* Inherited via groups */}
            <Section
                title="Inherited via groups"
                hint="Bindings the user picks up because they belong to a group with workspace access."
                icon={Users2}
                accent="violet"
                count={access.inheritedBindings.length}
            >
                {access.inheritedBindings.length === 0 ? (
                    <EmptyHint icon={Users2} text="No inherited bindings — the user isn't in any group with bindings." />
                ) : (
                    <div className="space-y-3">
                        {Object.entries(byGroup).map(([gid, list]) => {
                            const group = list[0].viaGroup!
                            return (
                                <div key={gid} className="rounded-xl border border-violet-500/20 bg-violet-500/[0.03]">
                                    <div className="flex items-center gap-2.5 px-3 py-2 border-b border-violet-500/15">
                                        <div className="w-7 h-7 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                                            <Users2 className="w-3.5 h-3.5 text-violet-500" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">{group.name}</p>
                                            <p className="text-[10px] text-violet-600/70 dark:text-violet-400/70">via group membership</p>
                                        </div>
                                        <span className="ml-auto text-[10px] font-semibold text-ink-muted">
                                            {list.length} binding{list.length !== 1 ? 's' : ''}
                                        </span>
                                    </div>
                                    <BindingList bindings={list} suppressViaGroup />
                                </div>
                            )
                        })}
                    </div>
                )}
            </Section>

            {/* Group memberships summary */}
            <Section
                title="Group memberships"
                hint="Every group this user belongs to."
                icon={Users}
                accent="violet"
                count={access.groups.length}
            >
                {access.groups.length === 0 ? (
                    <EmptyHint icon={Users} text="The user isn't in any groups yet." />
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {access.groups.map(g => (
                            <div key={g.id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-glass-border bg-glass-base/30">
                                <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                                    <Users2 className="w-3.5 h-3.5 text-violet-500" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-ink truncate">{g.name}</p>
                                    <p className="text-[11px] text-ink-muted">{g.memberCount} member{g.memberCount !== 1 ? 's' : ''}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </Section>
        </div>
    )
}


// ── Section / KPI helpers used by the access detail panel ──────────

function KpiTile({
    label, value, icon: Icon, accent,
}: {
    label: string
    value: number
    icon: typeof KeyRound
    accent: string
}) {
    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 px-3 py-2.5">
            <div className="flex items-center gap-2">
                <Icon className={cn('w-3.5 h-3.5', `text-${accent}-500`)} />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">{label}</span>
            </div>
            <p className={cn('text-xl font-bold mt-0.5', `text-${accent}-600 dark:text-${accent}-400`)}>{value}</p>
        </div>
    )
}


function Section({
    title, hint, icon: Icon, accent, count, children,
}: {
    title: string
    hint?: string
    icon: typeof KeyRound
    accent: string
    count?: number
    children: React.ReactNode
}) {
    return (
        <section>
            <div className="flex items-center gap-2 mb-2">
                <div className={cn('w-7 h-7 rounded-lg border flex items-center justify-center', `bg-${accent}-500/10 border-${accent}-500/20`)}>
                    <Icon className={cn('w-3.5 h-3.5', `text-${accent}-500`)} />
                </div>
                <h3 className="text-sm font-bold text-ink">{title}</h3>
                {count !== undefined && (
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-black/5 dark:bg-white/5 text-ink-muted">
                        {count}
                    </span>
                )}
            </div>
            {hint && <p className="text-[11px] text-ink-muted mb-3 ml-9">{hint}</p>}
            {children}
        </section>
    )
}


function EmptyHint({ icon: Icon, text }: { icon: typeof KeyRound; text: string }) {
    return (
        <div className="rounded-xl border border-dashed border-glass-border bg-glass-base/20 px-4 py-5 flex items-center gap-3 text-ink-muted">
            <Icon className="w-4 h-4 shrink-0" />
            <p className="text-xs">{text}</p>
        </div>
    )
}


function ScopeCard({
    scopeIcon: Icon, scopeLabel, scopeSublabel, accent, permissions,
}: {
    scopeIcon: typeof KeyRound
    scopeLabel: string
    scopeSublabel: string
    accent: string
    permissions: string[]
}) {
    return (
        <div className={cn('rounded-xl border bg-glass-base/30 overflow-hidden', `border-${accent}-500/20`)}>
            <div className="flex items-center gap-2.5 px-3 py-2 border-b border-glass-border">
                <div className={cn('w-7 h-7 rounded-lg border flex items-center justify-center', `bg-${accent}-500/10 border-${accent}-500/20`)}>
                    <Icon className={cn('w-3.5 h-3.5', `text-${accent}-500`)} />
                </div>
                <div className="min-w-0 flex-1">
                    <code className="text-xs font-mono font-semibold text-ink truncate block">{scopeLabel}</code>
                    <p className="text-[10px] text-ink-muted">{scopeSublabel}</p>
                </div>
                <span className="text-[10px] font-semibold text-ink-muted">
                    {permissions.length} perm{permissions.length !== 1 ? 's' : ''}
                </span>
            </div>
            <div className="flex flex-wrap gap-1.5 p-3">
                {permissions.length === 0 ? (
                    <span className="text-xs italic text-ink-muted">None</span>
                ) : (
                    permissions.map(p => (
                        <code
                            key={p}
                            className={cn(
                                'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border',
                                `bg-${accent}-500/5 text-${accent}-700 dark:text-${accent}-300 border-${accent}-500/20`,
                            )}
                        >
                            {p}
                        </code>
                    ))
                )}
            </div>
        </div>
    )
}


function BindingList({
    bindings, suppressViaGroup = false,
}: {
    bindings: AccessBinding[]
    suppressViaGroup?: boolean
}) {
    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 divide-y divide-glass-border">
            {bindings.map(b => {
                const v = ROLE_VISUAL[b.role] ?? ROLE_VISUAL.user
                const RoleIcon = v.icon
                return (
                    <div key={b.bindingId} className="flex items-center gap-3 px-3 py-2.5">
                        {/* Role badge */}
                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0', v.badge)}>
                            <RoleIcon className="w-2.5 h-2.5" />
                            {v.label}
                        </span>
                        {/* Scope */}
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {b.scope.type === 'global' ? (
                                <>
                                    <Lock className="w-3 h-3 text-violet-500 shrink-0" />
                                    <span className="text-xs font-semibold text-ink">Global</span>
                                </>
                            ) : (
                                <>
                                    <Briefcase className="w-3 h-3 text-indigo-500 shrink-0" />
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold text-ink truncate">
                                            {b.scope.label ?? b.scope.id}
                                        </p>
                                        {b.scope.label && (
                                            <code className="text-[10px] text-ink-muted truncate block">{b.scope.id}</code>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                        {/* Via group chip */}
                        {!suppressViaGroup && b.viaGroup && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20 shrink-0">
                                <Users2 className="w-2.5 h-2.5" />
                                {b.viaGroup.name}
                            </span>
                        )}
                    </div>
                )
            })}
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Tab 4 — By workspace (scope lens)
// ─────────────────────────────────────────────────────────────────────

function ByWorkspaceTab() {
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[] | null>(null)
    const [search, setSearch] = useState('')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [members, setMembers] = useState<WorkspaceMemberResponse[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { showToast } = useToast()

    useEffect(() => {
        ;(async () => {
            try {
                setWorkspaces(await workspaceService.list())
            } catch (err) {
                showToast('error', err instanceof Error ? err.message : 'Failed to load workspaces')
            }
        })()
    }, [showToast])

    useEffect(() => {
        if (!selectedId) { setMembers(null); return }
        setLoading(true)
        setError(null)
        ;(async () => {
            try {
                const data = await workspaceMembersService.list(selectedId)
                setMembers(data)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load members')
                setMembers(null)
            } finally {
                setLoading(false)
            }
        })()
    }, [selectedId])

    const filtered = useMemo(() => {
        if (!workspaces) return []
        const q = search.trim().toLowerCase()
        return workspaces
            .filter(w => !q || w.name.toLowerCase().includes(q) || (w.description ?? '').toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [workspaces, search])

    const counts = useMemo(() => {
        if (!members) return { total: 0, admin: 0, user: 0, viewer: 0, groups: 0, users: 0 }
        return {
            total: members.length,
            admin: members.filter(m => m.role === 'admin').length,
            user: members.filter(m => m.role === 'user').length,
            viewer: members.filter(m => m.role === 'viewer').length,
            groups: members.filter(m => m.subject.type === 'group').length,
            users: members.filter(m => m.subject.type === 'user').length,
        }
    }, [members])

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5 min-h-[60vh]">
            {/* Workspace picker */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden flex flex-col">
                <div className="p-3 border-b border-glass-border">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                        <input
                            type="text"
                            placeholder="Search workspaces..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="input pl-9 h-9 text-sm bg-glass-base/40 w-full"
                        />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {workspaces === null ? (
                        <div className="p-8 text-center text-ink-muted text-sm">
                            <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                            Loading…
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="p-8 text-center text-ink-muted text-sm">No matching workspaces.</div>
                    ) : (
                        filtered.map(w => {
                            const isSel = selectedId === w.id
                            return (
                                <button
                                    key={w.id}
                                    onClick={() => setSelectedId(w.id)}
                                    className={cn(
                                        'w-full flex items-center gap-2.5 px-3 py-2.5 border-b last:border-b-0 border-glass-border text-left transition-colors',
                                        isSel ? 'bg-emerald-500/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                    )}
                                >
                                    <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0">
                                        <Briefcase className="w-3.5 h-3.5 text-indigo-500" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className={cn('text-sm truncate', isSel ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-ink')}>
                                            {w.name}
                                        </p>
                                        <p className="text-[11px] text-ink-muted truncate">
                                            {w.dataSources?.length ?? 0} data source{(w.dataSources?.length ?? 0) !== 1 ? 's' : ''}
                                        </p>
                                    </div>
                                    {isSel && <ChevronRight className="w-4 h-4 text-emerald-500 shrink-0" />}
                                </button>
                            )
                        })
                    )}
                </div>
            </div>

            {/* Detail */}
            <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden flex flex-col">
                {!selectedId ? (
                    <div className="flex flex-col items-center justify-center flex-1 p-8 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4">
                            <Layers className="w-7 h-7 text-indigo-500" />
                        </div>
                        <p className="text-sm font-semibold text-ink mb-1">Pick a workspace</p>
                        <p className="text-xs text-ink-muted max-w-sm">
                            See every member binding (users + groups) and the role each one holds.
                        </p>
                    </div>
                ) : loading ? (
                    <div className="flex items-center justify-center flex-1">
                        <Loader2 className="w-5 h-5 animate-spin text-ink-muted" />
                    </div>
                ) : error ? (
                    <div className="p-8 text-center text-red-500 text-sm">{error}</div>
                ) : !members ? null : (
                    <WorkspaceMembersDetail
                        workspace={workspaces!.find(w => w.id === selectedId)!}
                        members={members}
                        counts={counts}
                    />
                )}
            </div>
        </div>
    )
}


function WorkspaceMembersDetail({
    workspace, members, counts,
}: {
    workspace: WorkspaceResponse
    members: WorkspaceMemberResponse[]
    counts: { total: number; admin: number; user: number; viewer: number; groups: number; users: number }
}) {
    return (
        <div className="overflow-y-auto p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shrink-0 shadow-md">
                    <Briefcase className="w-7 h-7 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold text-ink truncate">{workspace.name}</h2>
                    {workspace.description && (
                        <p className="text-sm text-ink-muted mt-0.5">{workspace.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-[11px] text-ink-muted">
                        <code className="font-mono px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border">{workspace.id}</code>
                        <Database className="w-3 h-3" />
                        {workspace.dataSources?.length ?? 0} data sources
                    </div>
                </div>
            </div>

            {/* KPI strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiTile label="Members" value={counts.total} icon={Users} accent="indigo" />
                <KpiTile label="Admins" value={counts.admin} icon={Shield} accent="amber" />
                <KpiTile label="Users" value={counts.user} icon={UserCog} accent="sky" />
                <KpiTile label="Viewers" value={counts.viewer} icon={Eye} accent="slate" />
            </div>

            {/* Member breakdown */}
            <Section
                title={`Members (${counts.total})`}
                hint={`${counts.users} direct user${counts.users === 1 ? '' : 's'} · ${counts.groups} group binding${counts.groups === 1 ? '' : 's'}`}
                icon={Users}
                accent="indigo"
            >
                {members.length === 0 ? (
                    <EmptyHint icon={Users} text="No members yet — go to the workspace and add some from the Members tab." />
                ) : (
                    <div className="rounded-xl border border-glass-border bg-glass-base/20 divide-y divide-glass-border">
                        {members.map(m => {
                            const v = ROLE_VISUAL[m.role] ?? ROLE_VISUAL.user
                            const RoleIcon = v.icon
                            const name = m.subject.displayName ?? m.subject.id
                            const isUser = m.subject.type === 'user'
                            return (
                                <div key={m.bindingId} className="flex items-center gap-3 px-3 py-2.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                                    {isUser ? (
                                        <div className={cn(
                                            'w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-[11px] font-bold text-white shrink-0',
                                            avatarGradient(name),
                                        )}>
                                            {initialsOf(name)}
                                        </div>
                                    ) : (
                                        <div className="w-9 h-9 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                                            <Users2 className="w-4 h-4 text-violet-500" />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-semibold text-ink truncate">{name}</p>
                                            {!isUser && (
                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 shrink-0">
                                                    GROUP
                                                </span>
                                            )}
                                        </div>
                                        {m.subject.secondary && (
                                            <p className="text-[11px] text-ink-muted truncate">{m.subject.secondary}</p>
                                        )}
                                    </div>
                                    <span className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border shrink-0', v.badge)}>
                                        <RoleIcon className="w-3 h-3" />
                                        {v.label}
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                )}
            </Section>
        </div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Role editor (read-only for system roles, editable for custom roles)
// ─────────────────────────────────────────────────────────────────────

function RoleEditorDrawer({
    role, permissions, onClose, onChanged,
}: {
    role: RoleDefinitionResponse
    permissions: PermissionResponse[]
    onClose: () => void
    onChanged: () => Promise<void>
}) {
    const isSystem = role.isSystem
    const [description, setDescription] = useState(role.description ?? '')
    const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set(role.permissions))
    const [saving, setSaving] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const { showToast } = useToast()

    const grouped = useMemo(() => groupByCategory(permissions), [permissions])

    const dirty = useMemo(() => {
        if (description !== (role.description ?? '')) return true
        const before = new Set(role.permissions)
        if (before.size !== selectedPerms.size) return true
        for (const p of selectedPerms) if (!before.has(p)) return true
        return false
    }, [description, selectedPerms, role])

    const togglePerm = (id: string) => {
        if (isSystem) return
        setSelectedPerms(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    const handleSave = async () => {
        if (isSystem) return
        setSaving(true)
        try {
            await permissionsService.updateRole(role.name, {
                description: description.trim() || null,
                permissions: Array.from(selectedPerms),
            })
            showToast('success', `Updated role "${role.name}"`)
            await onChanged()
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        if (isSystem) return
        setSaving(true)
        try {
            await permissionsService.deleteRole(role.name)
            showToast('success', `Deleted role "${role.name}"`)
            await onChanged()
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Delete failed')
            setConfirmDelete(false)
        } finally {
            setSaving(false)
        }
    }

    const v = ROLE_VISUAL[role.name] ?? CUSTOM_ROLE_VISUAL
    const RoleIcon = isSystem ? v.icon : Sparkles
    const labelText = isSystem ? v.label : role.name

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex"
        >
            <div className="absolute inset-0 bg-black/50" onClick={onClose} />
            <motion.aside
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 280 }}
                onClick={(e) => e.stopPropagation()}
                className="ml-auto relative w-full max-w-md bg-canvas-elevated border-l border-glass-border shadow-2xl flex flex-col"
            >
                {/* Header */}
                <div className="px-5 py-4 border-b border-glass-border flex items-start gap-3">
                    <div className={cn('w-11 h-11 rounded-xl border flex items-center justify-center shrink-0', v.iconBg)}>
                        <RoleIcon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-bold text-ink truncate">{labelText}</h2>
                            {isSystem && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-glass-base/40 text-ink-muted border border-glass-border">
                                    <Lock className="w-2.5 h-2.5" />
                                    System
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={cn(
                                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border',
                                role.scopeType === 'workspace'
                                    ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20'
                                    : 'bg-glass-base/40 text-ink-muted border-glass-border',
                            )}>
                                {role.scopeType === 'workspace'
                                    ? <><Briefcase className="w-2.5 h-2.5" />ws · {role.scopeId}</>
                                    : <><Globe className="w-2.5 h-2.5" />Global</>}
                            </span>
                            <span className="text-[10px] text-ink-muted">
                                {role.bindingCount} binding{role.bindingCount !== 1 ? 's' : ''}
                            </span>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* System role notice */}
                {isSystem && (
                    <div className="px-5 py-3 border-b border-glass-border bg-amber-500/5 flex items-start gap-2">
                        <Info className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                        <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                            System roles are read-only — their permission bundles are part of the platform's contract.
                            To customize, create a new role and bind it instead.
                        </p>
                    </div>
                )}

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Description */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                            Description
                        </label>
                        {isSystem ? (
                            <p className="text-sm text-ink-secondary p-3 rounded-lg border border-glass-border bg-glass-base/30">
                                {role.description || <span className="italic text-ink-muted">No description</span>}
                            </p>
                        ) : (
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                                placeholder="What this role is for..."
                                className="input w-full text-sm resize-none"
                            />
                        )}
                    </div>

                    {/* Permission picker */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                                Permissions
                            </label>
                            <span className="text-[11px] text-ink-muted">
                                {selectedPerms.size} of {permissions.length}
                            </span>
                        </div>
                        <div className="space-y-3">
                            {(['system', 'workspace', 'resource'] as const).map(cat => {
                                const list = grouped[cat] ?? []
                                if (list.length === 0) return null
                                const cv = CATEGORY_VISUAL[cat]
                                const CatIcon = cv.icon
                                return (
                                    <div key={cat} className="rounded-xl border border-glass-border bg-glass-base/20 overflow-hidden">
                                        <div className={cn('flex items-center gap-2 px-3 py-1.5 border-b border-glass-border', cv.pill, 'opacity-90')}>
                                            <CatIcon className="w-3 h-3" />
                                            <span className="text-[10px] uppercase font-bold tracking-wider">{cv.label}</span>
                                        </div>
                                        {list.map(p => {
                                            const on = selectedPerms.has(p.id)
                                            return (
                                                <div
                                                    key={p.id}
                                                    role="button"
                                                    tabIndex={isSystem ? -1 : 0}
                                                    aria-pressed={on}
                                                    aria-disabled={isSystem}
                                                    onClick={() => { if (!isSystem) togglePerm(p.id) }}
                                                    onKeyDown={(e) => {
                                                        if (isSystem) return
                                                        if (e.key === ' ' || e.key === 'Enter') {
                                                            e.preventDefault()
                                                            togglePerm(p.id)
                                                        }
                                                    }}
                                                    className={cn(
                                                        'w-full flex items-start gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border text-left transition-colors',
                                                        on ? 'bg-emerald-500/5' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                                        isSystem ? 'cursor-default' : 'cursor-pointer',
                                                    )}
                                                >
                                                    <div className={cn(
                                                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-0.5',
                                                        on
                                                            ? 'bg-emerald-500 border-emerald-500'
                                                            : 'bg-canvas-elevated border-ink-muted/30',
                                                    )}>
                                                        {on && <Check className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <code className="text-[11px] font-mono font-semibold text-ink truncate block">
                                                                {p.id}
                                                            </code>
                                                            <PermissionTooltip permission={p} placement="right" />
                                                        </div>
                                                        <p className="text-[10px] text-ink-muted truncate">{p.description}</p>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Dangerous zone for custom roles */}
                    {!isSystem && (
                        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                                <h4 className="text-[11px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                                    Danger zone
                                </h4>
                            </div>
                            {confirmDelete ? (
                                <div className="space-y-2">
                                    <p className="text-xs text-red-700 dark:text-red-400">
                                        {role.bindingCount > 0
                                            ? `This role is in ${role.bindingCount} active binding(s). Revoke them first.`
                                            : `Permanently delete the role "${role.name}"? This cannot be undone.`}
                                    </p>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setConfirmDelete(false)}
                                            disabled={saving}
                                            className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => void handleDelete()}
                                            disabled={saving || role.bindingCount > 0}
                                            className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                                        >
                                            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                                            Delete role
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setConfirmDelete(true)}
                                    disabled={role.bindingCount > 0}
                                    title={role.bindingCount > 0 ? 'Revoke active bindings before deleting' : 'Delete this role'}
                                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    <Trash2 className="w-3 h-3" />
                                    {role.bindingCount > 0
                                        ? `In use (${role.bindingCount} binding${role.bindingCount === 1 ? '' : 's'})`
                                        : 'Delete role'}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                {!isSystem && (
                    <div className="px-5 py-3 border-t border-glass-border bg-glass-base/20 flex items-center justify-end gap-2">
                        <button
                            onClick={onClose}
                            disabled={saving}
                            className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Close
                        </button>
                        <button
                            onClick={() => void handleSave()}
                            disabled={!dirty || saving}
                            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm shadow-accent-lineage/20"
                        >
                            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                            Save changes
                        </button>
                    </div>
                )}
            </motion.aside>
        </motion.div>
    )
}


// ─────────────────────────────────────────────────────────────────────
// Create role modal
// ─────────────────────────────────────────────────────────────────────

function CreateRoleModal({
    permissions, existingNames, onClose, onCreated,
}: {
    permissions: PermissionResponse[]
    existingNames: string[]
    onClose: () => void
    onCreated: () => Promise<void>
}) {
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [scopeType, setScopeType] = useState<'global' | 'workspace'>('global')
    const [scopeId, setScopeId] = useState<string>('')
    const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set())
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[] | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { showToast } = useToast()

    const grouped = useMemo(() => groupByCategory(permissions), [permissions])

    // Lazy-load workspaces only when the user picks workspace scope.
    useEffect(() => {
        if (scopeType !== 'workspace' || workspaces !== null) return
        ;(async () => {
            try {
                setWorkspaces(await workspaceService.list())
            } catch (err) {
                showToast('error', err instanceof Error ? err.message : 'Failed to load workspaces')
            }
        })()
    }, [scopeType, workspaces, showToast])

    const togglePerm = (id: string) => {
        setSelectedPerms(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    const nameTaken = existingNames.includes(name.trim())
    const valid =
        name.trim().length > 0
        && !nameTaken
        && (scopeType === 'global' || !!scopeId)

    const handleSubmit = async () => {
        if (!valid) return
        setSubmitting(true)
        setError(null)
        try {
            await permissionsService.createRole({
                name: name.trim(),
                description: description.trim() || null,
                scopeType,
                scopeId: scopeType === 'workspace' ? scopeId : null,
                permissions: Array.from(selectedPerms),
            })
            showToast('success', `Created role "${name.trim()}"`)
            await onCreated()
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Create failed'
            setError(msg)
            showToast('error', msg)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
            <div className="absolute inset-0 bg-black/50" onClick={onClose} />
            <motion.div
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-2xl flex flex-col max-h-[90vh]"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-glass-border shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-md shadow-violet-500/20">
                            <Sparkles className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-ink">New role</h3>
                            <p className="text-xs text-ink-muted">Define a custom role and the permissions it bundles</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto p-5 space-y-5">
                    {/* Name + description */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                Name <span className="text-red-500">*</span>
                            </label>
                            <input
                                autoFocus
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. auditor"
                                className="input w-full text-sm font-mono"
                            />
                            {nameTaken && (
                                <p className="text-[10px] text-red-500 mt-1">A role with that name already exists.</p>
                            )}
                        </div>
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                Description
                            </label>
                            <input
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="What this role is for"
                                className="input w-full text-sm"
                            />
                        </div>
                    </div>

                    {/* Scope selector */}
                    <div>
                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                            Scope
                        </label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <button
                                onClick={() => setScopeType('global')}
                                className={cn(
                                    'flex items-start gap-3 p-3 rounded-xl border-2 text-left transition-colors',
                                    scopeType === 'global'
                                        ? 'border-emerald-500 bg-emerald-500/5'
                                        : 'border-glass-border hover:border-ink-muted/30 bg-canvas-elevated',
                                )}
                            >
                                <div className={cn(
                                    'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0',
                                    scopeType === 'global'
                                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                                        : 'bg-glass-base/40 border-glass-border text-ink-muted',
                                )}>
                                    <Globe className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={cn('text-sm font-semibold', scopeType === 'global' ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink')}>
                                        Global
                                    </p>
                                    <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
                                        Bindable in any workspace or globally.
                                    </p>
                                </div>
                            </button>
                            <button
                                onClick={() => setScopeType('workspace')}
                                className={cn(
                                    'flex items-start gap-3 p-3 rounded-xl border-2 text-left transition-colors',
                                    scopeType === 'workspace'
                                        ? 'border-indigo-500 bg-indigo-500/5'
                                        : 'border-glass-border hover:border-ink-muted/30 bg-canvas-elevated',
                                )}
                            >
                                <div className={cn(
                                    'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0',
                                    scopeType === 'workspace'
                                        ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-500'
                                        : 'bg-glass-base/40 border-glass-border text-ink-muted',
                                )}>
                                    <Briefcase className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={cn('text-sm font-semibold', scopeType === 'workspace' ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink')}>
                                        Workspace-scoped
                                    </p>
                                    <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
                                        Only assignable inside one workspace.
                                    </p>
                                </div>
                            </button>
                        </div>
                        {scopeType === 'workspace' && (
                            <div className="mt-3">
                                <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5 block">
                                    Workspace
                                </label>
                                <select
                                    value={scopeId}
                                    onChange={(e) => setScopeId(e.target.value)}
                                    className="input w-full text-sm"
                                >
                                    <option value="">— Pick a workspace —</option>
                                    {(workspaces ?? []).map(w => (
                                        <option key={w.id} value={w.id}>{w.name} ({w.id})</option>
                                    ))}
                                </select>
                                {workspaces === null && (
                                    <p className="text-[10px] text-ink-muted mt-1">
                                        <Loader2 className="w-3 h-3 animate-spin inline-block mr-1" />
                                        Loading workspaces…
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Permission picker — same shape as the editor drawer */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                                Permissions
                            </label>
                            <span className="text-[11px] text-ink-muted">
                                {selectedPerms.size} of {permissions.length} selected
                            </span>
                        </div>
                        <div className="space-y-3">
                            {(['system', 'workspace', 'resource'] as const).map(cat => {
                                const list = grouped[cat] ?? []
                                if (list.length === 0) return null
                                const cv = CATEGORY_VISUAL[cat]
                                const CatIcon = cv.icon
                                const allSelected = list.every(p => selectedPerms.has(p.id))
                                const someSelected = list.some(p => selectedPerms.has(p.id))
                                return (
                                    <div key={cat} className="rounded-xl border border-glass-border bg-glass-base/20 overflow-hidden">
                                        <div className={cn('flex items-center gap-2 px-3 py-1.5 border-b border-glass-border', cv.pill, 'opacity-90')}>
                                            <CatIcon className="w-3 h-3" />
                                            <span className="text-[10px] uppercase font-bold tracking-wider">{cv.label}</span>
                                            <button
                                                onClick={() => {
                                                    setSelectedPerms(prev => {
                                                        const next = new Set(prev)
                                                        if (allSelected) {
                                                            list.forEach(p => next.delete(p.id))
                                                        } else {
                                                            list.forEach(p => next.add(p.id))
                                                        }
                                                        return next
                                                    })
                                                }}
                                                className="ml-auto text-[10px] font-semibold underline-offset-2 hover:underline"
                                            >
                                                {allSelected ? 'Clear all' : someSelected ? 'Select all' : 'Select all'}
                                            </button>
                                        </div>
                                        {list.map(p => {
                                            const on = selectedPerms.has(p.id)
                                            return (
                                                <div
                                                    key={p.id}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-pressed={on}
                                                    onClick={() => togglePerm(p.id)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === ' ' || e.key === 'Enter') {
                                                            e.preventDefault()
                                                            togglePerm(p.id)
                                                        }
                                                    }}
                                                    className={cn(
                                                        'w-full flex items-start gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border text-left transition-colors cursor-pointer',
                                                        on ? 'bg-emerald-500/5' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                                    )}
                                                >
                                                    <div className={cn(
                                                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-0.5',
                                                        on ? 'bg-emerald-500 border-emerald-500' : 'bg-canvas-elevated border-ink-muted/30',
                                                    )}>
                                                        {on && <Check className="w-2.5 h-2.5 text-white" />}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <code className="text-[11px] font-mono font-semibold text-ink truncate block">
                                                                {p.id}
                                                            </code>
                                                            <PermissionTooltip permission={p} placement="right" />
                                                        </div>
                                                        <p className="text-[10px] text-ink-muted truncate">{p.description}</p>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <p className="flex-1">{error}</p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-glass-border bg-glass-base/20 flex items-center justify-end gap-2 shrink-0">
                    <button
                        onClick={onClose}
                        disabled={submitting}
                        className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void handleSubmit()}
                        disabled={!valid || submitting}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm shadow-accent-lineage/20"
                    >
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        Create role
                    </button>
                </div>
            </motion.div>
        </motion.div>
    )
}
