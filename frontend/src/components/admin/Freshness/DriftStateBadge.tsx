/**
 * DriftStateBadge — the one place a reconciliation verdict is rendered.
 *
 * Used by the fleet row, the drawer, the provider group header and the data
 * source profile, so those four surfaces can never disagree about what a
 * drift state is called or which colour it wears.
 *
 * WHY ICON + LABEL, ALWAYS. "Rollups missing" (red) and "Drifting" (amber)
 * sit adjacent constantly — in the same table, in the same stat band. Their
 * light-mode text steps measure ΔE 14.4 apart to normal vision, below the 15
 * floor where two colours stop being reliably distinguishable at all, and
 * their CVD separation is worse. So colour is never the only channel here:
 * every state carries a distinct icon shape and a written label. Removing
 * either one makes two different problems look like the same problem.
 *
 * Fills use accent tokens at low alpha; text uses the paired 600/400 steps,
 * which clear 3:1 on both surfaces where the raw tokens do not.
 */
import {
    AlertTriangle, Ban, CheckCircle2, CircleDashed, EyeOff, PauseCircle,
    ShieldAlert, Waves,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** Mirrors ``reconcile.DRIFT_STATES`` on the backend. */
export type DriftState =
    | 'inSync'
    | 'drifting'
    | 'overlayMissing'
    | 'neverBuilt'
    | 'blocked'
    | 'unobservable'
    | 'suspended'

interface Spec {
    Icon: typeof Waves
    label: string
    tone: string
    title: string
}

export const DRIFT_SPEC: Record<DriftState, Spec> = {
    inSync: {
        Icon: CheckCircle2,
        label: 'In sync',
        tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        title: 'The rollups match the data last counted in this source.',
    },
    drifting: {
        Icon: Waves,
        label: 'Drifting',
        tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        title: 'The node or edge counts changed outside the app, so the rollups are behind.',
    },
    overlayMissing: {
        Icon: ShieldAlert,
        label: 'Rollups missing',
        tone: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
        title: 'This source has data but no rolled-up lineage — most likely wiped by a reload.',
    },
    neverBuilt: {
        Icon: CircleDashed,
        label: 'Never built',
        tone: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        title: 'Lineage has never been built for this source.',
    },
    blocked: {
        Icon: Ban,
        label: 'Blocked',
        tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
        title: 'Reconciliation cannot run — this source has no ontology assigned.',
    },
    unobservable: {
        Icon: EyeOff,
        label: 'Not observable',
        tone: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        title:
            'This source projects its rollups into a separate graph, which the ' +
            'statistics scan does not read — so their integrity cannot be checked ' +
            'from counts. Drift in the raw data is still detected.',
    },
    suspended: {
        Icon: AlertTriangle,
        label: 'Reconcile suspended',
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
        title:
            'Reconciliation rebuilt this source repeatedly without the problem ' +
            'clearing, so it stopped and is waiting for a person.',
    },
}

/** Plain-language reason clauses, keyed by the backend's detector codes. */
export const REASON_LABEL: Record<string, string> = {
    overlay_missing: 'Rollups were missing',
    overlay_shrunk: 'Rollups had shrunk',
    never_aggregated: 'First build',
    raw_drift: 'Counts had changed',
}

export function DriftStateBadge({
    state, className, showLabel = true,
}: {
    state?: string | null
    className?: string
    /** Icon-only, for dense rows. The label still ships as the title. */
    showLabel?: boolean
}) {
    const spec = state ? DRIFT_SPEC[state as DriftState] : undefined
    if (!spec) return null
    const { Icon, label, tone, title } = spec
    return (
        <span
            title={`${label} — ${title}`}
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border',
                'text-[10px] font-semibold',
                tone, className,
            )}
        >
            <Icon className="w-3 h-3 shrink-0" />
            {showLabel ? label : <span className="sr-only">{label}</span>}
        </span>
    )
}

/** The "Auto off" marker. Separate from the verdict — a source can be
 *  drifting AND excluded from automation, and both facts matter. */
export function AutoReconcileOffBadge({ className }: { className?: string }) {
    return (
        <span
            title="Automatic reconciliation is turned off for this source. Drift is still detected and shown, but nothing is rebuilt automatically."
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border',
                'text-[10px] font-semibold',
                'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
                className,
            )}
        >
            <PauseCircle className="w-3 h-3 shrink-0" />
            Auto off
        </span>
    )
}
