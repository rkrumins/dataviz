/**
 * MemoryMarks — each graph store node's memory, with the two marks that govern unloading drawn
 * across all of them: unloading STARTS when a node reaches the start mark, and STOPS once it is back
 * under the stop mark.
 *
 * Drag a mark, or focus it and use the arrow keys (Page Up / Page Down for five points, Home / End
 * for its limits). The stop mark can never pass the start mark less its margin: each mark stops
 * where the rule would break, rather than pushing the other. A moved mark turns the accent, with
 * a faint line where it was.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/units'
import { sliderKeyValue } from '@/components/ui/sliderKeys'
import type { NodeMemory } from '../types'
import { LegendKey, VisualFrame } from './VisualFrame'

type Mark = 'start' | 'stop'

export interface MemoryMarksProps {
    nodes: NodeMemory[]
    /** Percent of memory. */
    start: number
    stop: number
    /** Absent: the marks are shown, not moved. */
    onChange?: (start: number, stop: number) => void
    /** The saved marks, to show what moved. */
    saved?: { start: number; stop: number }
    startRange?: [number, number]
    stopRange?: [number, number]
    /** The stop mark sits at least this many points under the start mark. */
    margin?: number
    disabled?: boolean
    className?: string
}

const pctOf = (n: NodeMemory) => (n.maxBytes > 0 ? (n.usedBytes / n.maxBytes) * 100 : 0)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function MemoryMarks({
    nodes, start, stop, onChange, saved, startRange = [50, 95], stopRange = [30, 90], margin = 0, disabled = false, className,
}: MemoryMarksProps) {
    const track = useRef<HTMLDivElement>(null)
    const movable = Boolean(onChange) && !disabled
    const bounds: Record<Mark, [number, number]> = {
        start: [Math.max(startRange[0], stop + margin), startRange[1]],
        stop: [stopRange[0], Math.min(stopRange[1], start - margin)],
    }
    const value: Record<Mark, number> = { start, stop }

    const set = (mark: Mark, v: number) => {
        if (!onChange) return
        const next = Math.round(clamp(v, ...bounds[mark]))
        if (mark === 'start' && next !== start) onChange(next, stop)
        if (mark === 'stop' && next !== stop) onChange(start, next)
    }
    const fromPointer = (clientX: number) => {
        const r = track.current?.getBoundingClientRect()
        return r && r.width ? ((clientX - r.left) / r.width) * 100 : null
    }
    const handlers = (mark: Mark) => ({
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (!movable) return
            const next = sliderKeyValue(e.key, value[mark], { min: bounds[mark][0], max: bounds[mark][1], step: 1, bigStep: 5 })
            if (next === null) return
            e.preventDefault()
            set(mark, next)
        },
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
            if (!movable || e.button !== 0) return
            e.preventDefault()
            e.currentTarget.setPointerCapture?.(e.pointerId)
            e.currentTarget.focus()
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
            if (!movable || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return
            const v = fromPointer(e.clientX)
            if (v !== null) set(mark, v)
        },
    })

    const moved = (mark: Mark) => saved !== undefined && saved[mark] !== value[mark]
    const over = nodes.filter((n) => pctOf(n) >= start)
    const caption = (
        <>
            Unloading starts when a node reaches <strong className="font-semibold text-ink">{start}%</strong> of its memory and stops once it is under{' '}
            <strong className="font-semibold text-ink">{stop}%</strong>.{' '}
            {over.length === 0
                ? 'No node is over the start mark now.'
                : over.map((n) => `${n.label} (${Math.round(pctOf(n))}%) is over the start mark: graphs on it unload until it is under ${stop}%, about ${formatBytes(((pctOf(n) - stop) / 100) * n.maxBytes)}.`).join(' ')}
            {movable && ' Drag a mark, or focus it and use the arrow keys.'}
        </>
    )

    return (
        <VisualFrame
            title="Where unloading starts and stops"
            className={className}
            caption={caption}
            legend={(
                <>
                    <LegendKey className="bg-slate-400/70 dark:bg-slate-500">Room</LegendKey>
                    <LegendKey className="bg-amber-500/80">Between the marks</LegendKey>
                    <LegendKey className="bg-rose-500/80">Over the start mark</LegendKey>
                </>
            )}
        >
            <div className="relative select-none">
                {/* The scale, where the marks are held. */}
                <div ref={track} className="relative mx-2 h-9">
                    {(['stop', 'start'] as Mark[]).map((mark) => (
                        <div key={mark}>
                            {moved(mark) && saved && (
                                <span aria-hidden className="absolute bottom-0 h-3 w-px -translate-x-1/2 border-l border-dashed border-ink-muted/60"
                                    style={{ left: `${saved[mark]}%` }} />
                            )}
                            <div
                                role="slider"
                                tabIndex={disabled ? -1 : 0}
                                aria-label={mark === 'start' ? 'Start unloading at' : 'Stop unloading at'}
                                aria-valuemin={bounds[mark][0]}
                                aria-valuemax={bounds[mark][1]}
                                aria-valuenow={value[mark]}
                                aria-valuetext={`${value[mark]}% of memory`}
                                aria-disabled={!movable || undefined}
                                aria-readonly={!onChange || undefined}
                                {...handlers(mark)}
                                className={cn(
                                    'group absolute top-0 flex -translate-x-1/2 flex-col items-center outline-none touch-none',
                                    movable ? 'cursor-ew-resize' : 'cursor-default',
                                )}
                                style={{ left: `${value[mark]}%` }}
                            >
                                <span className={cn(
                                    'whitespace-nowrap rounded-md px-1.5 py-px text-[10.5px] font-semibold leading-4 tabular-nums',
                                    'group-focus-visible:ring-2 group-focus-visible:ring-accent-lineage/40',
                                    mark === 'start' ? 'translate-x-[calc(50%-6px)]' : '-translate-x-[calc(50%-6px)]',
                                    moved(mark) ? 'bg-accent-lineage text-white' : 'bg-ink-secondary text-ink-inverse',
                                )}>
                                    {mark === 'start' ? 'Start' : 'Stop'} {value[mark]}%
                                </span>
                                <span aria-hidden className={cn('mt-0.5 h-3 w-3 rotate-45 rounded-[2px]', moved(mark) ? 'bg-accent-lineage' : 'bg-ink-secondary')} />
                            </div>
                        </div>
                    ))}
                </div>

                {/* The marks, drawn through every gauge. */}
                <div className="relative mx-2">
                    <ul className="space-y-3.5 pt-1">
                        {nodes.map((n) => {
                            const p = pctOf(n)
                            const zone = p >= start ? 'over' : p >= stop ? 'between' : 'room'
                            return (
                                <li key={n.id}>
                                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[11.5px]">
                                        <span className="font-semibold text-ink">{n.label}</span>
                                        <span className="tabular-nums text-ink-muted">
                                            {formatBytes(n.usedBytes)} of {formatBytes(n.maxBytes)} · <span className="font-medium text-ink-secondary">{Math.round(p)}%</span>
                                            {' · '}
                                            <span className={cn(zone === 'over' ? 'text-rose-600 dark:text-rose-400' : zone === 'between' ? 'text-amber-700 dark:text-amber-400' : '')}>
                                                {zone === 'over' ? 'Unloads now' : zone === 'between' ? 'Between the marks' : 'Room to load'}
                                            </span>
                                        </span>
                                    </div>
                                    <div className="relative">
                                        <div role="meter" aria-label={`Memory of ${n.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}
                                            aria-valuetext={`${Math.round(p)}% used, ${formatBytes(n.usedBytes)} of ${formatBytes(n.maxBytes)}`}
                                            className="relative h-2.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                                            <span aria-hidden className="absolute inset-y-0 bg-amber-500/[0.10]" style={{ left: `${stop}%`, width: `${Math.max(0, start - stop)}%` }} />
                                            <span aria-hidden className="absolute inset-y-0 right-0 bg-rose-500/[0.10]" style={{ left: `${start}%` }} />
                                            <span aria-hidden className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 motion-reduce:transition-none',
                                                zone === 'over' ? 'bg-rose-500/80' : zone === 'between' ? 'bg-amber-500/80' : 'bg-slate-400/70 dark:bg-slate-500')}
                                                style={{ width: `${Math.min(100, p)}%` }} />
                                        </div>
                                        {/* The marks cross each gauge, not the words above it. */}
                                        {(['stop', 'start'] as Mark[]).map((mark) => (
                                            <span key={mark} aria-hidden className={cn('pointer-events-none absolute -top-1 h-[18px] w-0.5 -translate-x-1/2 rounded-full',
                                                moved(mark) ? 'bg-accent-lineage' : 'bg-ink-secondary/80')} style={{ left: `${value[mark]}%` }} />
                                        ))}
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                    <div aria-hidden className="mt-2 flex justify-between text-[10px] tabular-nums text-ink-muted">
                        <span>0%</span><span>50%</span><span>100%</span>
                    </div>
                </div>
            </div>
        </VisualFrame>
    )
}
