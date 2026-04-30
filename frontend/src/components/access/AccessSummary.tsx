/**
 * AccessSummary — visual breakdown of one user's full access picture.
 *
 * Renders the same payload (``UserAccessResponse``) on two surfaces:
 *
 *   * Admin "By user" lens (mode='admin') — the admin is inspecting
 *     someone else's access. Header copy + empty hints frame it as
 *     third-person.
 *   * Self-service My Access page (mode='self') — the caller is
 *     reading their own access. Copy switches to second-person.
 *
 * The component was extracted from AdminPermissions.tsx (Phase 4.2).
 * Both consumers share a single layout so the two pages can never
 * drift visually or factually.
 */
import { useMemo } from 'react'
import {
    KeyRound, Shield, UserCog, Eye, Users2, Users, Briefcase,
    Sparkles, GitBranch, Lock, Mail,
} from 'lucide-react'
import type { UserAccessResponse, AccessBinding } from '@/services/permissionsService'
import { avatarGradient, initialsOf } from '@/lib/avatar'
import { cn } from '@/lib/utils'


// Role-chip palette. Kept local on purpose — the source-of-truth in
// AdminPermissions has more knobs (gradient, iconBg) for the matrix
// hero. This stripped-down map only needs ``label`` + ``icon`` +
// ``badge`` for the BindingList chip.
const ROLE_VISUAL: Record<string, {
    label: string
    icon: typeof Shield
    badge: string
}> = {
    admin: {
        label: 'Admin',
        icon: Shield,
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    user: {
        label: 'User',
        icon: UserCog,
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    },
    viewer: {
        label: 'Viewer',
        icon: Eye,
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    },
}

const CUSTOM_ROLE_VISUAL = {
    label: 'Custom',
    icon: Sparkles,
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
} as const


export type AccessSummaryMode = 'admin' | 'self'

export interface AccessSummaryProps {
    access: UserAccessResponse
    /** ``'admin'`` (third-person) or ``'self'`` (second-person). */
    mode?: AccessSummaryMode
    /** Hide the user header — useful when the page already shows the
     *  identity above the summary. */
    hideHeader?: boolean
}


export function AccessSummary({
    access, mode = 'admin', hideHeader = false,
}: AccessSummaryProps) {
    const totalBindings = access.directBindings.length + access.inheritedBindings.length
    const wsCount = Object.keys(access.effectiveWs).length
    const isAdmin = access.effectiveGlobal.includes('system:admin')
    const isSelf = mode === 'self'

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

    // Build a {workspaceId → resolved name} map from every binding so
    // the per-workspace ScopeCard can show the workspace's friendly
    // name rather than its raw ``ws_*`` id.
    const wsLabels = useMemo(() => {
        const out: Record<string, string> = {}
        for (const b of [...access.directBindings, ...access.inheritedBindings]) {
            if (b.scope.type === 'workspace' && b.scope.id && b.scope.label) {
                out[b.scope.id] = b.scope.label
            }
        }
        return out
    }, [access.directBindings, access.inheritedBindings])

    return (
        <div className="overflow-y-auto p-6 space-y-6">
            {!hideHeader && (
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
            )}

            <div className="grid grid-cols-3 gap-3">
                <KpiTile label="Total bindings" value={totalBindings} icon={GitBranch} accent="emerald" />
                <KpiTile label="Workspaces reached" value={wsCount} icon={Briefcase} accent="indigo" />
                <KpiTile label="Group memberships" value={access.groups.length} icon={Users2} accent="violet" />
            </div>

            <Section
                title="Effective access"
                hint={isSelf
                    ? 'What you can actually do, after merging your direct + group bindings.'
                    : 'What this user can actually do, after merging direct + group bindings.'}
                icon={Sparkles}
                accent="emerald"
            >
                {access.effectiveGlobal.length === 0 && Object.keys(access.effectiveWs).length === 0 && !isAdmin ? (
                    <EmptyHint
                        icon={Lock}
                        text={isSelf
                            ? "You don't have any effective permissions yet — ask an admin to grant you access."
                            : "No effective permissions — the user can't access anything until granted a binding."}
                    />
                ) : (
                    <div className="space-y-3">
                        {access.effectiveGlobal.length > 0 && (
                            <ScopeCard
                                scopeIcon={Lock}
                                scopeLabel="Global"
                                scopeSublabel="System-wide permissions"
                                accent="violet"
                                permissions={access.effectiveGlobal}
                                monospaceLabel={false}
                            />
                        )}
                        {Object.entries(access.effectiveWs).map(([wsId, perms]) => {
                            const friendly = wsLabels[wsId]
                            return (
                                <ScopeCard
                                    key={wsId}
                                    scopeIcon={Briefcase}
                                    scopeLabel={friendly ?? wsId}
                                    scopeSublabel={friendly ? wsId : 'Workspace permissions'}
                                    accent="indigo"
                                    permissions={perms}
                                    monospaceLabel={!friendly}
                                    monospaceSublabel={Boolean(friendly)}
                                />
                            )
                        })}
                    </div>
                )}
            </Section>

            <Section
                title="Direct bindings"
                hint={isSelf
                    ? 'Bindings attached to you directly — independent of any group you belong to.'
                    : 'Bindings attached to the user directly — independent of group membership.'}
                icon={UserCog}
                accent="sky"
                count={access.directBindings.length}
            >
                {access.directBindings.length === 0 ? (
                    <EmptyHint
                        icon={UserCog}
                        text={isSelf
                            ? 'No direct bindings. All your access comes via group membership.'
                            : 'No direct bindings. All access comes via group membership.'}
                    />
                ) : (
                    <BindingList bindings={access.directBindings} />
                )}
            </Section>

            <Section
                title="Inherited via groups"
                hint={isSelf
                    ? 'Bindings you pick up because you belong to a group with workspace access.'
                    : 'Bindings the user picks up because they belong to a group with workspace access.'}
                icon={Users2}
                accent="violet"
                count={access.inheritedBindings.length}
            >
                {access.inheritedBindings.length === 0 ? (
                    <EmptyHint
                        icon={Users2}
                        text={isSelf
                            ? "No inherited bindings — you're not in any group with bindings."
                            : "No inherited bindings — the user isn't in any group with bindings."}
                    />
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

            <Section
                title="Group memberships"
                hint={isSelf
                    ? 'Every group you belong to.'
                    : 'Every group this user belongs to.'}
                icon={Users}
                accent="violet"
                count={access.groups.length}
            >
                {access.groups.length === 0 ? (
                    <EmptyHint
                        icon={Users}
                        text={isSelf ? "You aren't in any groups yet." : "The user isn't in any groups yet."}
                    />
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


// ── Sub-components (file-local) ─────────────────────────────────────

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
    monospaceLabel = true, monospaceSublabel = false,
}: {
    scopeIcon: typeof KeyRound
    scopeLabel: string
    scopeSublabel: string
    accent: string
    permissions: string[]
    /** Render the label in monospace? Friendly names should be off;
     *  raw ``ws_*`` ids should be on. */
    monospaceLabel?: boolean
    /** Render the sublabel in monospace? Use when the sublabel is
     *  the workspace id rendered below a friendly name. */
    monospaceSublabel?: boolean
}) {
    return (
        <div className={cn('rounded-xl border bg-glass-base/30 overflow-hidden', `border-${accent}-500/20`)}>
            <div className="flex items-center gap-2.5 px-3 py-2 border-b border-glass-border">
                <div className={cn('w-7 h-7 rounded-lg border flex items-center justify-center', `bg-${accent}-500/10 border-${accent}-500/20`)}>
                    <Icon className={cn('w-3.5 h-3.5', `text-${accent}-500`)} />
                </div>
                <div className="min-w-0 flex-1">
                    {monospaceLabel ? (
                        <code className="text-xs font-mono font-semibold text-ink truncate block">{scopeLabel}</code>
                    ) : (
                        <p className="text-sm font-semibold text-ink truncate">{scopeLabel}</p>
                    )}
                    {monospaceSublabel ? (
                        <code className="text-[10px] text-ink-muted truncate block font-mono">{scopeSublabel}</code>
                    ) : (
                        <p className="text-[10px] text-ink-muted truncate">{scopeSublabel}</p>
                    )}
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
                const v = ROLE_VISUAL[b.role] ?? CUSTOM_ROLE_VISUAL
                const RoleIcon = v.icon
                return (
                    <div key={b.bindingId} className="flex items-center gap-3 px-3 py-2.5">
                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0', v.badge)}>
                            <RoleIcon className="w-2.5 h-2.5" />
                            {v.label}
                        </span>
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
