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
import { ShieldOff } from 'lucide-react'
import { useAuthStore } from '@/store/auth'


interface RequirePermissionProps {
    perm: string
    /** Optional element rendered when the user lacks the permission.
     *  Default: a centered access-denied empty-state panel matching
     *  the rest of the admin shell. */
    fallback?: ReactNode
    children: ReactNode
}


export function RequirePermission({ perm, fallback, children }: RequirePermissionProps) {
    const allowed = useAuthStore((s) => s.can(perm))
    if (allowed) return <>{children}</>
    return <>{fallback ?? <DeniedPanel permission={perm} />}</>
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
    const allowed = useAuthStore((s) => s.can(perm, ws))
    if (allowed) return <>{children}</>
    return <>{fallback ?? <DeniedPanel permission={perm} workspace={ws} />}</>
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
