/**
 * FreshnessStatBand — the triage cockpit's overview row: seven stat tiles that
 * double as the status filter. Each tile is a toggle button (``aria-pressed``);
 * clicking it selects that status facet, clicking the active one — or "Total" —
 * clears back to all. The tiles are overlapping facets, not a partition (a row
 * can be both Ready and Rebuilding), so the numbers can sum past the total.
 *
 * Counts come straight from the server ``summary`` (exact and fleet-wide). The
 * facet a tile toggles is filtered client-side by the matching predicate in
 * ``freshnessTriage`` — same predicate the count was computed with — so a
 * tile's number equals the rows it reveals. When ``summary`` is null (fleet too
 * large to summarise), the band renders nothing.
 */
import { AlertTriangle, CheckCircle2, Database, Layers, Loader2, MinusCircle, Waves } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FreshnessSummary } from '@/services/freshnessService'
import { DRIFT_SPEC } from './DriftStateBadge'
import type { StatusFacet } from './freshnessTriage'

interface Accent {
    /** Icon chip background + colour. */
    chip: string
    /** Value text colour. */
    value: string
    /** Ring + border when the tile is the active facet. */
    activeRing: string
    /** Faint always-on surface tint (used to keep "needs attention" warm). */
    restTint?: string
}

const ACCENTS: Record<string, Accent> = {
    indigo: { chip: 'bg-indigo-500/10 text-indigo-500', value: 'text-indigo-600 dark:text-indigo-400', activeRing: 'border-indigo-500/60 ring-indigo-500/30' },
    emerald: { chip: 'bg-emerald-500/10 text-emerald-500', value: 'text-emerald-600 dark:text-emerald-400', activeRing: 'border-emerald-500/60 ring-emerald-500/30' },
    sky: { chip: 'bg-sky-500/10 text-sky-500', value: 'text-sky-600 dark:text-sky-400', activeRing: 'border-sky-500/60 ring-sky-500/30' },
    amber: { chip: 'bg-amber-500/15 text-amber-500', value: 'text-amber-600 dark:text-amber-400', activeRing: 'border-amber-500/60 ring-amber-500/30', restTint: 'bg-amber-500/[0.04] border-amber-500/25' },
    slate: { chip: 'bg-slate-500/10 text-slate-500', value: 'text-slate-600 dark:text-slate-400', activeRing: 'border-slate-500/60 ring-slate-500/30' },
    violet: { chip: 'bg-violet-500/10 text-violet-500', value: 'text-violet-600 dark:text-violet-400', activeRing: 'border-violet-500/60 ring-violet-500/30' },
    // Drifting sits beside "Needs attention" (amber) in the band, so it takes
    // rose rather than a second amber — and it carries its own icon and label
    // besides, because those two hues are close enough that colour alone must
    // never be what tells them apart.
    rose: { chip: 'bg-rose-500/15 text-rose-500', value: 'text-rose-600 dark:text-rose-400', activeRing: 'border-rose-500/60 ring-rose-500/30', restTint: 'bg-rose-500/[0.04] border-rose-500/25' },
    // The one tile that only appears when it has something to say, so it is
    // allowed to be the loudest thing in the band: a full red border and a
    // tint two steps warmer than Drifting's, which it sits next to.
    red: { chip: 'bg-red-500/15 text-red-500', value: 'text-red-600 dark:text-red-400', activeRing: 'border-red-500/60 ring-red-500/30', restTint: 'bg-red-500/[0.07] border-red-500/40' },
}

function Tile({
    icon: Icon, label, value, secondary, accent, active, onToggle, spin,
}: {
    icon: typeof Layers
    label: string
    value: string
    secondary?: React.ReactNode
    accent: Accent
    active: boolean
    onToggle: () => void
    spin?: boolean
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onToggle}
            className={cn(
                'group relative rounded-xl border px-3.5 py-3 text-left outline-none transition-all',
                'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                active
                    ? cn('ring-2', accent.activeRing)
                    : cn(
                        accent.restTint ?? 'border-glass-border/60 bg-canvas',
                        'hover:border-glass-border hover:shadow-sm',
                    ),
            )}
        >
            <div className="flex items-center gap-3">
                <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0', accent.chip)}>
                    <Icon className={cn('w-4 h-4', spin && 'animate-spin')} />
                </div>
                <div className="min-w-0">
                    <p className={cn('text-xl font-bold tabular-nums leading-none tracking-tight', accent.value)}>{value}</p>
                    <p className="text-[10px] text-ink-muted/70 uppercase tracking-wider font-bold mt-1 truncate">{label}</p>
                </div>
            </div>
            {secondary}
        </button>
    )
}

export function FreshnessStatBand({ summary, activeFacet, onToggle }: {
    summary: FreshnessSummary | null | undefined
    activeFacet: StatusFacet
    onToggle: (facet: StatusFacet) => void
}) {
    // Null when the fleet is too large to summarise — no tiles rather than
    // guessed numbers.
    if (!summary) return null

    // Toggling the active facet clears it; Total always clears.
    const toggle = (facet: StatusFacet) => onToggle(activeFacet === facet ? '' : facet)

    const coverage = summary.total > 0 ? Math.round((summary.cacheStamped / summary.total) * 100) : 0

    // The only conditional tile in the band. A permanent "0 connections not up
    // to date" would be noise on every healthy fleet, and this state is rare
    // and red; it earns its place by appearing. It also stays rendered while
    // it is the active facet, so clearing a filter never removes the control
    // that set it.
    const stalled = summary.projectionStalled ?? 0
    const showStalled = stalled > 0 || activeFacet === 'projectionStalled'

    return (
        <div
            role="group"
            aria-label="Fleet summary"
            className={cn(
                'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3',
                showStalled ? 'wide:grid-cols-8' : 'wide:grid-cols-7',
            )}
        >
            <Tile
                icon={Layers} label="Total sources" value={summary.total.toLocaleString()}
                accent={ACCENTS.indigo} active={activeFacet === ''}
                onToggle={() => onToggle('')}
            />
            <Tile
                icon={CheckCircle2} label="Ready" value={summary.ready.toLocaleString()}
                accent={ACCENTS.emerald} active={activeFacet === 'ready'}
                onToggle={() => toggle('ready')}
            />
            {/* Ahead of Drifting, because it outranks it: a drifting source
                is serving stale rolled-up connections, this one is serving
                none. Never folded INTO Drifting — that tile's remedy is a
                rebuild, and a rebuild does not restart a projector. The two
                sit adjacent in red and rose, so the icon (Unplug vs Waves)
                and the full label carry the distinction. */}
            {showStalled && (
                <Tile
                    icon={DRIFT_SPEC.projectionStalled.Icon}
                    label={DRIFT_SPEC.projectionStalled.label}
                    value={stalled.toLocaleString()}
                    accent={ACCENTS.red} active={activeFacet === 'projectionStalled'}
                    onToggle={() => toggle('projectionStalled')}
                    // Plain ``text-ink-muted``, no alpha: it is a bare var()
                    // token, so a ``/70`` suffix would emit no rule at all and
                    // this line would render invisible.
                    secondary={
                        <p className="mt-2 text-[10px] text-ink-muted leading-snug">
                            Rolled-up connections are missing — a rebuild won't fix it
                        </p>
                    }
                />
            )}
            <Tile
                icon={Waves} label="Drifting" value={(summary.drifting ?? 0).toLocaleString()}
                accent={ACCENTS.rose} active={activeFacet === 'drifting'}
                onToggle={() => toggle('drifting')}
                secondary={
                    summary.drifting > 0 ? (
                        <p className="mt-2 text-[10px] text-ink-muted/70 leading-snug">
                            Rollups no longer match the data
                        </p>
                    ) : undefined
                }
            />
            <Tile
                icon={Loader2} label="Rebuilding now" value={summary.pending.toLocaleString()} spin={summary.pending > 0}
                accent={ACCENTS.sky} active={activeFacet === 'pending'}
                onToggle={() => toggle('pending')}
            />
            <Tile
                icon={AlertTriangle} label="Needs attention" value={summary.needsAttention.toLocaleString()}
                accent={ACCENTS.amber} active={activeFacet === 'needsAttention'}
                onToggle={() => toggle('needsAttention')}
            />
            <Tile
                icon={MinusCircle} label="Not built" value={summary.notBuilt.toLocaleString()}
                accent={ACCENTS.slate} active={activeFacet === 'notBuilt'}
                onToggle={() => toggle('notBuilt')}
            />
            <Tile
                icon={Database} label="Cache coverage" value={`${coverage}%`}
                accent={ACCENTS.violet} active={activeFacet === 'cacheStamped'}
                onToggle={() => toggle('cacheStamped')}
                secondary={
                    <div className="mt-2.5">
                        <div className="h-1 rounded-full bg-violet-500/15 overflow-hidden">
                            <div className="h-full rounded-full bg-violet-500" style={{ width: `${coverage}%` }} />
                        </div>
                        <p className="mt-1 text-[10px] text-ink-muted/70 tabular-nums">
                            {summary.cacheStamped.toLocaleString()} / {summary.total.toLocaleString()} cached
                        </p>
                    </div>
                }
            />
        </div>
    )
}
