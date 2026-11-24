/**
 * DayRibbon — one person's day on a 24-hour line.
 *
 * Each session is a band from its first event to its last; each event is a tick
 * in its kind's colour, taller for actions than for moves around the app. The
 * shape of a day — one long stretch, or a sign-in at nine and a burst after
 * lunch — is the thing a list of events cannot show.
 *
 * Hours are UTC, like the day itself. Hovering or focusing a tick names it in the
 * readout; clicking one asks the page to bring that event into view.
 */
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { ActivityEventRow, DaySession } from '@/services/peopleActivityService'
import { KIND_META, utcClock as clock } from '../people/activityKinds'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

const HEIGHT = 76
const PAD = { left: 8, right: 8, top: 22, bottom: 18 }

function minuteOf(iso: string): number {
    const d = new Date(iso)
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60
}

export function DayRibbon({ events, sessions, onSelect, className }: {
    events: ActivityEventRow[]
    sessions: DaySession[]
    onSelect?: (eventId: string) => void
    className?: string
}) {
    const theme = useChartTheme()
    const [wrapRef, width] = useChartWidth()
    const [hover, setHover] = useState<ActivityEventRow | null>(null)
    const plot = Math.max(0, width - PAD.left - PAD.right)
    const x = (minute: number) => PAD.left + (minute / 1440) * plot

    const colour = (kind: string) => {
        const slot = KIND_META[kind as keyof typeof KIND_META]?.slot
        return slot === undefined ? theme.neutralMark : theme.series[slot % theme.series.length]
    }

    const ticks = useMemo(() => events.map((e) => ({ e, m: minuteOf(e.at) })), [events])
    const base = HEIGHT - PAD.bottom

    return (
        <div className={cn('space-y-1', className)}>
            <div className="min-h-[1.25rem] text-[11px]" aria-live="polite">
                {hover ? (
                    <span>
                        <span className="font-semibold tabular-nums text-ink">{clock(hover.at)} UTC</span>
                        <span className="text-ink-muted"> · </span>
                        <span className="text-ink-secondary">{hover.label}</span>
                        {hover.view?.name && <span className="text-ink-muted"> — {hover.view.name}</span>}
                    </span>
                ) : (
                    <span className="text-ink-muted">
                        {sessions.length
                            ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}, split wherever nothing happened for 30 minutes`
                            : 'Nothing happened on this day.'}
                    </span>
                )}
            </div>
            <div ref={wrapRef} className="w-full">
                {width > 0 && (
                    <svg width={width} height={HEIGHT} role="img"
                        aria-label={`${events.length} events across ${sessions.length} sessions, by hour of the day in UTC`}>
                        {/* Hour grid. */}
                        {Array.from({ length: 25 }, (_, h) => (
                            <g key={h}>
                                <line x1={x(h * 60)} x2={x(h * 60)} y1={PAD.top - 4} y2={base}
                                    stroke={theme.grid} strokeWidth={h % 6 === 0 ? 1 : 0.5} />
                                {h % 3 === 0 && h < 24 && (
                                    <text x={x(h * 60) + 2} y={HEIGHT - 4}
                                        className="fill-ink-muted tabular-nums" style={{ fontSize: 9 }}>{String(h).padStart(2, '0')}</text>
                                )}
                            </g>
                        ))}
                        {/* Sessions. */}
                        {sessions.map((s, i) => {
                            const a = x(minuteOf(s.start))
                            const b = Math.max(a + 3, x(minuteOf(s.end)))
                            return (
                                <rect key={i} x={a - 1.5} y={PAD.top} width={b - a + 3} height={base - PAD.top}
                                    rx={4} fill={theme.series[1]} opacity={0.12} />
                            )
                        })}
                        {/* Events. */}
                        {ticks.map(({ e, m }) => {
                            const actionish = e.kind !== 'section'
                            const top = actionish ? PAD.top + 4 : PAD.top + 18
                            const isHover = hover?.id === e.id
                            return (
                                <g key={e.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`${clock(e.at)} UTC: ${e.label}`}
                                    onMouseEnter={() => setHover(e)}
                                    onMouseLeave={() => setHover(null)}
                                    onFocus={() => setHover(e)}
                                    onBlur={() => setHover(null)}
                                    onClick={() => onSelect?.(e.id)}
                                    onKeyDown={(k) => { if (k.key === 'Enter') onSelect?.(e.id) }}
                                    className="cursor-pointer outline-none">
                                    {/* A wider, invisible target than the mark. */}
                                    <rect x={x(m) - 5} y={PAD.top} width={10} height={base - PAD.top} fill="transparent" />
                                    <line x1={x(m)} x2={x(m)} y1={top} y2={base - 4}
                                        stroke={colour(e.kind)} strokeWidth={isHover ? 3 : MARK.lineWidth}
                                        strokeLinecap="round" opacity={isHover || !hover ? 1 : 0.45} />
                                </g>
                            )
                        })}
                        <text x={width - PAD.right} y={12} textAnchor="end" className="fill-ink-muted"
                            style={{ fontSize: 9, fontWeight: 700 }}>UTC</text>
                    </svg>
                )}
            </div>
        </div>
    )
}
