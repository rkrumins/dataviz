/**
 * PropertyNameBudget — how much of a graph's attribute-name ceiling is spent.
 *
 * FalkorDB identifies every property name by a `uint16_t`, so a graph can
 * register 65,534 distinct names and **they are never freed**: deleting the
 * data does not return an id, and only dropping the whole graph resets the
 * map. That makes this a one-way budget, which is why it is drawn as a METER
 * against a limit rather than as a count beside node and edge totals — the
 * number alone does not say how much runway is left.
 *
 * FORM. A single ratio against a limit is a meter, not a chart and not a
 * two-slice pie. The split inside the bar is EMPHASIS, not a categorical
 * palette: the platform's own reserved names are fixed context and wear the
 * de-emphasis gray, while the names this source's data introduced are the
 * subject and carry the status hue. One hue plus gray needs no categorical
 * palette, so there is no adjacent-pair separation to get wrong.
 *
 * COLOUR. The hue is a STATUS, not a series colour — this is a limit that can
 * actually be hit. Status never appears alone: every band ships with its text
 * label and an icon, so the state survives greyscale, colour-blindness and
 * forced-colors. Numbers stay in ink tokens; only the marks carry the hue.
 */
import { AlertTriangle, CheckCircle2, Info, TriangleAlert } from 'lucide-react'

import { cn } from '@/lib/utils'

/** `uint16_t` ids, minus the two the engine keeps for itself. */
export const PROPERTY_NAME_CEILING = 65_534

type Band = {
    key: 'healthy' | 'filling' | 'near'
    label: string
    Icon: typeof CheckCircle2
    /** The subject segment + the status pill. */
    fill: string
    pill: string
    /** The matching KpiCard accent, so callers never re-derive the mapping. */
    accent: 'emerald' | 'amber' | 'rose'
}

const BANDS: Record<Band['key'], Band> = {
    healthy: {
        key: 'healthy',
        label: 'Healthy',
        Icon: CheckCircle2,
        fill: 'bg-emerald-500',
        pill: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20',
        accent: 'emerald',
    },
    filling: {
        key: 'filling',
        label: 'Filling up',
        Icon: TriangleAlert,
        fill: 'bg-amber-500',
        pill: 'text-amber-600 bg-amber-500/10 border-amber-500/20',
        accent: 'amber',
    },
    near: {
        key: 'near',
        label: 'Near the limit',
        Icon: AlertTriangle,
        fill: 'bg-rose-500',
        pill: 'text-rose-600 bg-rose-500/10 border-rose-500/20',
        accent: 'rose',
    },
}

export function propertyNameBand(total: number): Band {
    const pct = (total / PROPERTY_NAME_CEILING) * 100
    if (pct >= 90) return BANDS.near
    if (pct >= 70) return BANDS.filling
    return BANDS.healthy
}

export interface PropertyNameBudgetProps {
    /** Registered names. `null`/`undefined` renders the not-measured state —
     *  never coerce a missing reading to 0, they mean opposite things. */
    total?: number | null
    /** Names the platform reserves for itself. Omitted → no split is drawn. */
    platform?: number | null
    /** `total - platform`, floored at 0. An ESTIMATE: the reserve is written
     *  best-effort, so a graph that never completed one has fewer platform
     *  names than the constant claims, which under-counts this side. */
    source?: number | null
    /** Tight variant for a row; the full one gets the label and legend. */
    compact?: boolean
    className?: string
}

export function PropertyNameBudget({
    total, platform, source, compact = false, className,
}: PropertyNameBudgetProps) {
    if (total == null) {
        return (
            <div className={cn('flex items-center gap-1.5 text-[11px] text-ink-muted', className)}>
                <Info className="w-3 h-3 shrink-0" />
                <span>Property names not measured yet</span>
            </div>
        )
    }

    const band = propertyNameBand(total)
    const pct = Math.min(100, (total / PROPERTY_NAME_CEILING) * 100)
    const shown = pct > 0 && pct < 0.5 ? 0.5 : pct   // a real reading never renders as an empty track
    const hasSplit = platform != null && source != null && total > 0
    // Platform's share OF THE TRACK, not of the total — both segments are
    // measured against the ceiling so the bar reads as one budget.
    const platformPct = hasSplit
        ? Math.min(shown, (platform! / PROPERTY_NAME_CEILING) * 100)
        : 0
    const sourcePct = Math.max(0, shown - platformPct)
    const title = `${total.toLocaleString()} of ${PROPERTY_NAME_CEILING.toLocaleString()} property names registered`
        + (hasSplit ? ` — ${platform!.toLocaleString()} reserved by the platform, ~${source!.toLocaleString()} from this source's data` : '')

    return (
        <div className={cn('w-full', className)} title={title}>
            {!compact && (
                <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">
                        Property names
                    </p>
                    <div className="flex items-center gap-1.5">
                        <span className={cn(
                            'inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full border',
                            band.pill,
                        )}>
                            <band.Icon className="w-2.5 h-2.5" aria-hidden />
                            {band.label}
                        </span>
                        <span className="text-[11px] font-black text-ink tabular-nums">
                            {Math.round(pct)}%
                        </span>
                    </div>
                </div>
            )}

            <div
                className="flex items-center gap-2"
                role="meter"
                aria-valuenow={total}
                aria-valuemin={0}
                aria-valuemax={PROPERTY_NAME_CEILING}
                aria-label={title}
            >
                <div className="flex-1 h-2 rounded-full bg-black/8 dark:bg-white/8 overflow-hidden flex">
                    {hasSplit && platformPct > 0 && (
                        <div
                            className="h-full bg-slate-400/70 dark:bg-slate-500/70 transition-all duration-700"
                            // 2px surface gap so the two fills read as separate
                            // marks rather than one blended bar.
                            style={{ width: `${platformPct}%`, marginRight: '2px' }}
                        />
                    )}
                    <div
                        className={cn('h-full transition-all duration-700', band.fill)}
                        style={{ width: `${sourcePct}%` }}
                    />
                </div>
                <span className="text-[11px] font-semibold text-ink tabular-nums shrink-0">
                    {total.toLocaleString()}
                    <span className="text-ink-muted font-normal"> / {PROPERTY_NAME_CEILING.toLocaleString()}</span>
                </span>
            </div>

            {!compact && hasSplit && (
                // Direct labels, not a legend box: two series, so identity is
                // never carried by colour alone.
                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-muted">
                    <span className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-400/70 dark:bg-slate-500/70 shrink-0" />
                        {platform!.toLocaleString()} platform
                    </span>
                    <span className="flex items-center gap-1">
                        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', band.fill)} />
                        ~{source!.toLocaleString()} from this source
                    </span>
                </div>
            )}

            {!compact && band.key === 'near' && (
                <p className="mt-1.5 text-[10px] text-rose-600 dark:text-rose-400">
                    Names are never freed — this graph will need recreating to reclaim them.
                </p>
            )}
        </div>
    )
}
