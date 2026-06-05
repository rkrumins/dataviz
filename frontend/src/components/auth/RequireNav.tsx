/**
 * Spec-driven route guard. Consumes a ``NavPermissionSpec`` from the
 * centralised catalogue (``lib/navPermissions``) so the route + the
 * sidebar item that points at it share one source of truth.
 */
import type { ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { useNavPermission } from '@/store/auth'
import type { NavPermissionSpec } from '@/lib/navPermissions'


interface RequireNavProps {
    spec: NavPermissionSpec
    fallback?: ReactNode
    children: ReactNode
}


export function RequireNav({ spec, fallback, children }: RequireNavProps) {
    const allowed = useNavPermission(spec)
    if (allowed) return <>{children}</>
    return <>{fallback ?? <DeniedPanel spec={spec} />}</>
}


function DeniedPanel({ spec }: { spec: NavPermissionSpec }) {
    const desc = describe(spec)
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
                    This section requires {desc}.
                </p>
                <p className="text-xs text-ink-muted/80 mt-3">
                    Ask your workspace admin or system administrator if you should have it.
                </p>
            </div>
        </div>
    )
}


function describe(spec: NavPermissionSpec): ReactNode {
    switch (spec.kind) {
        case 'always':
            return 'authentication'
        case 'perm':
            return (
                <>
                    the{' '}
                    <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border text-ink-secondary">
                        {spec.perm}
                    </code>
                    {' '}permission
                </>
            )
        case 'anyPerm':
            return (
                <>
                    any of:{' '}
                    {spec.perms.map((p, i) => (
                        <span key={p}>
                            <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border text-ink-secondary">
                                {p}
                            </code>
                            {i < spec.perms.length - 1 && ', '}
                        </span>
                    ))}
                </>
            )
        case 'workspaceAny':
            return (
                <>
                    the{' '}
                    <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-glass-base/40 border border-glass-border text-ink-secondary">
                        {spec.perm}
                    </code>
                    {' '}permission in at least one workspace
                </>
            )
    }
}
