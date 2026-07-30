/**
 * Route + element guards for RBAC-gated UI.
 *
 *   <RequirePermission perm="system:admin">
 *     <AdminPage />
 *   </RequirePermission>
 *
 *   <RequireWorkspacePermission ws={wsId} perm="workspace:admin">
 *     <WorkspaceMembersTab />
 *   </RequireWorkspacePermission>
 *
 * The component subscribes to the auth store's permission slice so it
 * re-renders if the user gains/loses the permission mid-session
 * (e.g. after a silent refresh updated their bindings).
 *
 * This is **advisory gating** only. The backend remains the source of
 * truth — the same actions are also enforced server-side. Hiding them
 * here is purely a UX concern.
 */
import type { ReactNode } from 'react'
import { ShieldOff, RefreshCw, WifiOff } from 'lucide-react'
import {
    useAuthStore,
    usePermissionsReady,
    usePermissionsUnavailable,
} from '@/store/auth'


interface RequirePermissionProps {
    /** Single permission required. Mutually exclusive with ``anyOf``. */
    perm?: string
    /** Any-of permission set — user passes when they hold at least one. */
    anyOf?: string[]
    /** Optional element rendered when the user lacks the permission.
     *  Default: a centered access-denied empty-state panel matching
     *  the rest of the admin shell. */
    fallback?: ReactNode
    children: ReactNode
}


export function RequirePermission({ perm, anyOf, fallback, children }: RequirePermissionProps) {
    const ready = usePermissionsReady()
    const unavailable = usePermissionsUnavailable()
    const allowed = useAuthStore((s) => {
        if (anyOf && anyOf.length > 0) return s.canAny(anyOf)
        if (perm) return s.can(perm)
        return false
    })
    // We asked and got no answer. Say that — do not dress a failed
    // request up as a denial.
    if (unavailable) return <UnavailablePanel />
    // Claims not in yet: "we don't know" is not "you may not". Denying
    // here is how the access-denied panel came to flash before content.
    if (!ready) return <GuardSkeleton />
    if (allowed) return <>{children}</>
    const displayPerm = perm ?? (anyOf && anyOf.length > 0 ? anyOf.join(' or ') : 'unknown')
    return <>{fallback ?? <DeniedPanel permission={displayPerm} />}</>
}


interface RequireWorkspacePermissionProps {
    ws: string
    perm: string
    fallback?: ReactNode
    children: ReactNode
}


export function RequireWorkspacePermission({
    ws,
    perm,
    fallback,
    children,
}: RequireWorkspacePermissionProps) {
    const ready = usePermissionsReady()
    const unavailable = usePermissionsUnavailable()
    const allowed = useAuthStore((s) => s.can(perm, ws))
    if (unavailable) return <UnavailablePanel />
    if (!ready) return <GuardSkeleton />
    if (allowed) return <>{children}</>
    return <>{fallback ?? <DeniedPanel permission={perm} workspace={ws} />}</>
}


// ── Waiting on claims ───────────────────────────────────────────────

/**
 * Placeholder for a guard whose claims haven't landed. Deliberately the
 * same ``min-h-[60vh]`` footprint as ``DeniedPanel`` below (and as
 * ``RequireNav``'s and ``RequireFeature``'s panels) so resolving to
 * either outcome doesn't shift the page. Shared with those guards
 * rather than copied four times.
 */
export function GuardSkeleton() {
    return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
            <div className="w-full max-w-sm space-y-4" aria-hidden>
                <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/10 animate-pulse mx-auto" />
                <div className="h-4 w-40 bg-black/5 dark:bg-white/10 rounded animate-pulse mx-auto" />
                <div className="h-3 w-full bg-black/5 dark:bg-white/10 rounded animate-pulse" />
                <div className="h-3 w-2/3 bg-black/5 dark:bg-white/10 rounded animate-pulse mx-auto" />
            </div>
        </div>
    )
}


// ── Could not check ─────────────────────────────────────────────────

/**
 * Shown when resolving the caller's permissions failed outright and there
 * was no earlier answer to fall back on.
 *
 * This state used to be rendered as {@link DeniedPanel} — "You don't have
 * access" — because a failed resolve was recorded as a definitive empty
 * one. So a single rate-limited or timed-out request during boot told
 * users they had lost access to everything, in the same words as a real
 * denial, and left it on screen until a later poll happened to succeed.
 * That is the bug reported as "it says I don't have permission, then the
 * page loads".
 *
 * Shares ``DeniedPanel``'s ``min-h-[60vh]`` footprint so resolving to
 * either outcome doesn't shift the page.
 */
export function UnavailablePanel() {
    return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
            <div className="max-w-sm text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-ink-muted/15 to-ink-muted/0 border border-glass-border flex items-center justify-center mx-auto mb-5">
                    <WifiOff className="w-7 h-7 text-ink-muted" />
                </div>
                <h2 className="text-base font-bold text-ink mb-1.5">
                    Couldn't check your access
                </h2>
                <p className="text-sm text-ink-muted leading-relaxed">
                    We couldn't reach the server to find out what you're allowed
                    to see. This isn't a permissions problem — your access hasn't
                    changed.
                </p>
                <button
                    type="button"
                    onClick={() => {
                        void useAuthStore.getState().refreshPermissions()
                    }}
                    className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-glass-border bg-canvas-elevated text-ink-secondary hover:text-ink hover:border-ink-muted/40 transition-colors"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Try again
                </button>
            </div>
        </div>
    )
}


// ── Default fallback ────────────────────────────────────────────────

function DeniedPanel({ permission, workspace }: { permission: string; workspace?: string }) {
    return (
        <div className="flex items-center justify-center min-h-[60vh] p-8">
            <div className="max-w-sm text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500/20 to-amber-500/0 border border-amber-500/20 flex items-center justify-center mx-auto mb-5">
                    <ShieldOff className="w-7 h-7 text-amber-500" />
                </div>
                <h2 className="text-base font-bold text-ink mb-1.5">
                    You don't have access
                </h2>
                <p className="text-sm text-ink-muted leading-relaxed">
                    This section requires the{' '}
                    <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border text-ink-secondary">
                        {permission}
                    </code>
                    {' '}permission
                    {workspace && (
                        <> in workspace{' '}
                            <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border text-ink-secondary">
                                {workspace}
                            </code>
                        </>
                    )}.
                </p>
                <p className="text-xs text-ink-muted/80 mt-3">
                    Ask your workspace admin or system administrator if you should have it.
                </p>
            </div>
        </div>
    )
}
