/**
 * FirstRun — the panel a brand-new deployment sees instead of six empty charts.
 *
 * Zeros everywhere is a legitimate state, and rendering it as "No activity in
 * this range" six times over reads as a broken dashboard on a dead product.
 * It is neither: nothing has happened because nothing has been set up yet, and
 * the reader is one or two actions away from every number on this page having
 * a value.
 *
 * So this says what is missing and links to the steps that fix it — each step
 * gated on whether this reader can actually take it, because an operator who
 * cannot invite anyone should not be told to go and invite someone.
 */
import { ArrowRight, Boxes, Database, Sparkles, UserPlus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { useNavPermission } from '@/store/auth'
import type { AnalyticsSummary } from '@/services/analyticsService'

/**
 * Nothing has been built and nothing has been connected.
 *
 * Read from the platform-wide totals, which every reader gets in full at every
 * privacy level — so a redacted viewer on a live platform never sees this, and
 * a redacted viewer on an empty one gets the same honest explanation an
 * administrator does.
 */
export function isFirstRun(data: AnalyticsSummary): boolean {
    const { workspaces, views, dataSources } = data.totals
    return (workspaces.total ?? 0) === 0
        && (views.total ?? 0) === 0
        && (dataSources.total ?? 0) === 0
}

export function FirstRun() {
    // Called unconditionally and in a fixed order — the same discipline the
    // sidebar uses, because a hook behind a condition is called on some
    // renders and not others.
    const canConnect = useNavPermission({
        kind: 'anyPerm',
        perms: ['system:admin', 'system:org-admin', 'workspace:datasource:manage'],
    })
    const canInvite = useNavPermission({ kind: 'perm', perm: 'system:admin' })

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-sm">
            <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10">
                    <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-sm font-bold text-ink">
                        Nothing to measure yet
                    </h2>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                        Every figure on this page counts something people did. No
                        workspaces, views or data sources exist yet, so there is
                        nothing to count — not a gap in the data. The numbers start
                        moving as soon as the platform does.
                    </p>
                </div>
            </div>

            <ul className="mt-4 grid gap-2 sm:grid-cols-3">
                <Step
                    to="/workspaces" icon={Boxes} label="Create a workspace"
                    detail="Where views and data sources live"
                />
                {canConnect && (
                    <Step
                        to="/ingestion" icon={Database} label="Connect a data source"
                        detail="The graph is built from what you connect"
                    />
                )}
                {canInvite && (
                    <Step
                        to="/admin/users" icon={UserPlus} label="Invite your team"
                        detail="Active users, growth and retention need people"
                    />
                )}
            </ul>
        </section>
    )
}

function Step({
    to, icon: Icon, label, detail,
}: {
    to: string
    icon: typeof Boxes
    label: string
    detail: string
}) {
    return (
        <li>
            <Link
                to={to}
                className="group flex h-full items-start gap-2.5 rounded-xl border border-glass-border p-3 outline-none transition-colors hover:border-indigo-500/30 hover:bg-black/[0.02] focus-visible:ring-2 focus-visible:ring-indigo-500/50 dark:hover:bg-white/[0.03]"
            >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                <span className="min-w-0">
                    <span className="flex items-center gap-1 text-xs font-semibold text-ink">
                        {label}
                        <ArrowRight
                            className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60"
                            aria-hidden
                        />
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">
                        {detail}
                    </span>
                </span>
            </Link>
        </li>
    )
}
