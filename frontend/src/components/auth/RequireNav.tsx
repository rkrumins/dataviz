/**
 * Section-driven route guard. Resolves the visibility spec from the
 * centralised nav catalogue store (backend-served, seeded by bundled
 * defaults) so the route + the sidebar item that points at it share
 * one runtime source of truth.
 *
 * Pass a section reference (``group`` + ``sectionKey``) so the guard
 * reads the live spec from the store — the route definitions stay
 * static while the gate stays in sync with the served catalogue.
 */
import type { ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import {
    useNavPermission,
    usePermissionsReady,
    usePermissionsUnavailable,
} from '@/store/auth'
import { GuardSkeleton, UnavailablePanel } from '@/components/auth/RequirePermission'
import {
    useSidebarSpec,
    useAdminSectionSpec,
    useNavCatalogueStore,
} from '@/store/navCatalogue'
import type { NavPermissionSpec } from '@/lib/navPermissions'
import type { NavigationTab } from '@/store/navigation'


interface RequireNavProps {
    /** Which catalogue the ``sectionKey`` belongs to. */
    group: 'sidebar' | 'admin'
    /** Catalogue key: a ``NavigationTab`` for ``sidebar`` or an admin
     *  route segment (overview / groups / …) for ``admin``. */
    sectionKey: string
    fallback?: ReactNode
    children: ReactNode
}


export function RequireNav({ group, sectionKey, fallback, children }: RequireNavProps) {
    // Both hooks run every render (hook-rules); only the relevant one's
    // result is used. Cheap — each is a single store selector.
    const sidebarSpec = useSidebarSpec(sectionKey as NavigationTab)
    const adminSpec = useAdminSectionSpec(sectionKey)
    const spec = group === 'sidebar' ? sidebarSpec : adminSpec
    const ready = usePermissionsReady()
    const unavailable = usePermissionsUnavailable()
    // The SPEC is the other half of this verdict, and it has its own
    // arrival time. Until the served catalogue lands, an unknown section
    // key falls back to a hidden-by-default spec — so a fully-resolved
    // super-admin could still be shown "You don't have access" for a
    // section the seed simply didn't list, until the fetch completed.
    // (``redis`` was exactly that.) Waiting on both means the denial we
    // render is one the backend actually agrees with.
    const catalogueLoaded = useNavCatalogueStore((s) => s.loaded)
    const allowed = useNavPermission(spec)
    if (unavailable) return <UnavailablePanel />
    // Un-hydrated claims are indistinguishable from a real denial when
    // read off the claims slice alone — wait for the answer.
    if (!ready || !catalogueLoaded) return <GuardSkeleton />
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
