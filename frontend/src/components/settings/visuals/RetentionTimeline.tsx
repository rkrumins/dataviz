/**
 * RetentionTimeline and IdleTimeline — two clocks people set without seeing them.
 *
 * - RETENTION: a draft closes (merged or abandoned), its changes are kept N days, then removed at
 *   the next hourly sweep; the draft's record stays. Pick "a draft closed … days ago" to see
 *   whether its changes are still there. Forever keeps them.
 * - IDLE: a graph nobody reads unloads after its class's idle time (Standard, Coldline; Always
 *   never does). Pick "last read … ago" to see which are still loaded. On a log scale, so a minute
 *   and a year both fit.
 *
 * Staged values show in the accent.
 */
import { useState, type ReactNode } from 'react'
import { Infinity as Forever } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDays, formatDuration } from '@/lib/units'
import { Slider } from '@/components/ui/Slider'
import { LegendKey, VisualFrame } from './VisualFrame'

type Days = number | 'forever'

function Pin({ at, label, tone = 'ink', below = false }: { at: number; label: ReactNode; tone?: 'ink' | 'accent' | 'rose'; below?: boolean }) {
    const align = at < 12 ? 'left-0' : at > 88 ? 'right-0' : '-translate-x-1/2'
    return (
        <span aria-hidden className="absolute top-0 bottom-0" style={{ left: `${at}%` }}>
            <span className={cn('absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas-elevated',
                tone === 'accent' ? 'bg-accent-lineage' : tone === 'rose' ? 'bg-rose-500' : 'bg-ink-secondary')} />
            <span className={cn('absolute whitespace-nowrap text-[10.5px] font-medium', below ? 'top-[calc(50%+10px)]' : 'bottom-[calc(50%+10px)]',
                align === 'left-0' ? 'left-0' : align === 'right-0' ? 'right-0' : '-translate-x-1/2',
                tone === 'accent' ? 'text-indigo-700 dark:text-indigo-300' : 'text-ink-secondary')}>
                {label}
            </span>
        </span>
    )
}

export function RetentionTimeline({ days, nextDays, className }: { days: Days; nextDays?: Days; className?: string }) {
    const changed = nextDays !== undefined && nextDays !== days
    const longest = Math.max(typeof days === 'number' ? days : 0, changed && typeof nextDays === 'number' ? nextDays : 0)
    const span = longest ? Math.max(14, Math.ceil((longest * 1.6) / 10) * 10) : 90
    const [ago, setAgo] = useState(() => Math.min(span, typeof days === 'number' ? Math.round(days / 2) : 30))
    const x = (d: number) => Math.min(100, (d / span) * 100)
    const kept = days === 'forever' ? 100 : x(days)
    const shown = Math.min(ago, span)
    const fate = days === 'forever'
        ? 'its changes are kept for good.'
        : shown < days
            ? `its changes are kept for ${formatDays(days - shown)} more.`
            : `its changes were removed ${shown === days ? 'today' : `${formatDays(shown - days)} ago`}; its record stays.`
    const fateNext = changed && nextDays !== undefined
        ? nextDays === 'forever' ? 'they would be kept for good.'
            : shown < nextDays ? `they would be kept for ${formatDays(nextDays - shown)} more.` : 'they would already be removed.'
        : null

    return (
        <VisualFrame
            title="What happens to a closed draft’s changes"
            className={className}
            legend={(
                <>
                    <LegendKey kind="line" className="border-ink-secondary">Changes kept</LegendKey>
                    <LegendKey kind="dashed" className="border-ink-muted">Only the record stays</LegendKey>
                    {changed && <LegendKey className="bg-accent-lineage">Your change</LegendKey>}
                </>
            )}
            caption={(
                <>
                    A draft closed {formatDays(shown)} ago: {fate}
                    {fateNext && <>{' '}<span className="font-medium text-indigo-700 dark:text-indigo-300">With your change, {fateNext}</span></>}
                    {' '}A merged draft’s changes stay in the published graph either way.
                </>
            )}
        >
            <div className="relative mx-1 h-20">
                <span aria-hidden className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-ink-secondary/80" style={{ width: `${kept}%` }} />
                {days !== 'forever' && (
                    <span aria-hidden className="absolute top-1/2 right-0 -translate-y-1/2 border-t-2 border-dashed border-ink-muted/50" style={{ left: `${kept}%` }} />
                )}
                <Pin at={0} label="Draft closes" />
                {days === 'forever'
                    ? <span aria-hidden className="absolute right-0 top-1/2 -translate-y-1/2 text-ink-secondary"><Forever className="w-4 h-4" /></span>
                    : <Pin at={kept} tone="rose" label={`Removed after ${formatDays(days)}`} />}
                {changed && nextDays !== undefined && nextDays !== 'forever' && <Pin at={x(nextDays)} tone="accent" below label={`Your change: ${formatDays(nextDays)}`} />}
                {changed && nextDays === 'forever' && <Pin at={100} tone="accent" below label="Your change: forever" />}
                <span aria-hidden className="absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" style={{ left: `${x(shown)}%` }} />
            </div>
            <Slider className="mt-2" aria-label="A draft closed this many days ago" value={shown} onChange={setAgo} min={0} max={span} step={1}
                fill={false} format={(d) => `${formatDays(d)} ago`} ends={['Closed today', `${formatDays(span)} ago`]} />
        </VisualFrame>
    )
}

// ── Idle unloading ──────────────────────────────────────────────────────────

const MIN_SECS = 60
// On a log scale "30 days" sits too close to "1 week" for both labels to fit: it is left out.
const TICKS: Array<[number, string]> = [[60, '1 minute'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week'], [31536000, '1 year']]

export function IdleTimeline({ standardIdleSecs, coldlineIdleSecs, autoUnload = true, next, className }: {
    standardIdleSecs: number
    coldlineIdleSecs: number
    autoUnload?: boolean
    next?: { standardIdleSecs?: number; coldlineIdleSecs?: number }
    className?: string
}) {
    const maxSecs = Math.max(31536000, standardIdleSecs * 2, next?.standardIdleSecs ? next.standardIdleSecs * 2 : 0)
    const lo = Math.log(MIN_SECS)
    const hi = Math.log(maxSecs)
    const x = (secs: number) => ((Math.log(Math.max(MIN_SECS, secs)) - lo) / (hi - lo)) * 100
    const [pos, setPos] = useState(() => Math.round(x(86400) * 10))
    const idle = Math.round(Math.exp(lo + ((pos / 1000) * (hi - lo))))
    const lanes = [
        { id: 'always', label: 'Always', secs: null as number | null, next: undefined as number | undefined },
        { id: 'standard', label: 'Standard', secs: standardIdleSecs, next: next?.standardIdleSecs },
        { id: 'coldline', label: 'Coldline', secs: coldlineIdleSecs, next: next?.coldlineIdleSecs },
    ]
    const loaded = (secs: number | null) => !autoUnload || secs === null || idle < secs
    const read = (s: number) => formatDuration(s, { style: 'long' }).split(' ').slice(0, 2).join(' ')

    return (
        <VisualFrame
            title="When an unread graph unloads"
            className={className}
            legend={(
                <>
                    <LegendKey kind="line" className="border-ink-secondary">Loaded</LegendKey>
                    <LegendKey kind="dashed" className="border-ink-muted">Unloaded: the next read loads it</LegendKey>
                </>
            )}
            caption={!autoUnload
                ? 'Unloading graphs automatically is off: nothing unloads, however long it goes unread.'
                : `Last read ${read(idle)} ago: ${lanes.map((l) => `${l.label} is ${loaded(l.secs) ? 'still loaded' : 'unloaded'}`).join(', ')}.`}
        >
            <div className="space-y-2">
                {lanes.map((l) => {
                    const end = l.secs === null || !autoUnload ? 100 : x(l.secs)
                    return (
                        // A phone stacks each lane's track under its name; wider, they share a line.
                        <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[4.5rem_minmax(0,1fr)_6.5rem]">
                            <span className="col-start-1 row-start-1 text-xs font-semibold text-ink">{l.label}</span>
                            <div className="relative col-span-2 row-start-2 h-6 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                                <span aria-hidden className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-secondary/75" style={{ width: `${end}%` }} />
                                {end < 100 && <span aria-hidden className="absolute right-0 top-1/2 -translate-y-1/2 border-t-2 border-dashed border-ink-muted/45" style={{ left: `${end}%` }} />}
                                {end < 100 && <span aria-hidden className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas-elevated bg-ink-secondary" style={{ left: `${end}%` }} />}
                                {l.next !== undefined && l.next !== l.secs && autoUnload && (
                                    <span aria-hidden className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-lineage" style={{ left: `${x(l.next)}%` }} />
                                )}
                                <span aria-hidden className="absolute inset-y-0 w-px bg-ink/70" style={{ left: `${pos / 10}%` }} />
                            </div>
                            <span className={cn('col-start-2 row-start-1 text-right text-[11px] sm:col-start-3 sm:text-left', loaded(l.secs) ? 'text-ink' : 'text-ink-secondary')}>
                                {l.secs === null || !autoUnload ? 'Never unloads' : `After ${read(l.secs)}`}
                                {l.next !== undefined && l.next !== l.secs && autoUnload && <span className="block font-semibold text-indigo-700 dark:text-indigo-300">→ {read(l.next)}</span>}
                            </span>
                        </div>
                    )
                })}
                <div aria-hidden className="relative h-4 text-[10px] text-ink-secondary sm:ml-[5.25rem] sm:mr-[7.25rem]">
                    {TICKS.filter(([s]) => s <= maxSecs).map(([s, label]) => (
                        <span key={s} className={cn('absolute whitespace-nowrap', s === MIN_SECS ? '' : x(s) > 97 ? '-translate-x-full' : '-translate-x-1/2')}
                            style={{ left: `${x(s)}%` }}>{label}</span>
                    ))}
                </div>
            </div>
            <Slider className="mt-2 sm:ml-[5.25rem] sm:mr-[7.25rem]" aria-label="Last read this long ago" value={pos} onChange={setPos} min={0} max={1000} step={5}
                fill={false} format={() => `Last read ${read(idle)} ago`} ends={false} />
        </VisualFrame>
    )
}
