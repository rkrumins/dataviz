/**
 * ReadTimeline — scrub through a new version landing (before, while, after) and watch, for every
 * read mode, what readers see and where each read comes from: the graph store, or the database.
 *
 * Built from each choice's `frames`. The mode in force is marked, and a staged one is marked in the
 * accent; the caption narrates the moment for the mode in force (and the staged one). Move the
 * scrubber with the pointer or the arrow keys, or press Play to step through.
 */
import { useEffect, useId, useState } from 'react'
import { motion } from 'framer-motion'
import { Database, HardDrive, Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Slider } from '@/components/ui/Slider'
import { sameValue } from '../format'
import type { Choice, Frame, Setting, SettingValue } from '../types'
import { useCalmMotion } from './motion'
import { VisualFrame } from './VisualFrame'

const PHASES: Array<{ when: Frame['when']; label: string; long: string }> = [
    { when: 'before', label: 'Before', long: 'Before a new version lands' },
    { when: 'while', label: 'While it lands', long: 'While a new version lands' },
    { when: 'after', label: 'After', long: 'After it has landed' },
]

function tone(c: Choice, f: Frame): 'old' | 'new' | 'mix' {
    const before = c.frames.find((x) => x.when === 'before')?.shows
    const after = c.frames.find((x) => x.when === 'after')?.shows
    if (f.shows === after && f.shows !== before) return 'new'
    return f.shows === before ? 'old' : 'mix'
}

function narrate(c: Choice, phase: number): string {
    const f = c.frames.find((x) => x.when === PHASES[phase].when)
    if (!f) return ''
    return `${PHASES[phase].long}, readers of “${c.title}” see ${f.shows.charAt(0).toLowerCase()}${f.shows.slice(1)}, read from the ${f.source}${f.note ? ` (${f.note.charAt(0).toLowerCase()}${f.note.slice(1)})` : ''}.`
}

export function ReadTimeline({ setting, value, next, className }: {
    setting: Setting
    /** The choice in force. */
    value: SettingValue
    /** A staged choice. */
    next?: SettingValue
    className?: string
}) {
    const id = useId()
    const { transition } = useCalmMotion({ type: 'spring', stiffness: 420, damping: 36 })
    const [phase, setPhase] = useState(1)
    const [playing, setPlaying] = useState(false)
    const choices = setting.choices.filter((c) => c.frames.length > 0)
    const inForce = choices.find((c) => sameValue(c.id, value))
    const staged = next !== undefined && !sameValue(next, value) ? choices.find((c) => sameValue(c.id, next)) : undefined

    useEffect(() => {
        if (!playing) return
        const t = window.setTimeout(() => {
            if (phase >= PHASES.length - 1) setPlaying(false)
            else setPhase(phase + 1)
        }, 1500)
        return () => window.clearTimeout(t)
    }, [playing, phase])

    if (choices.length === 0) return null
    const ROW = 'h-[4.25rem]'

    return (
        <VisualFrame
            title="What readers see while a new version lands"
            className={className}
            legend={(
                <>
                    <span className="inline-flex items-center gap-1"><HardDrive aria-hidden className="w-3 h-3" /> Graph store: fast</span>
                    <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><Database aria-hidden className="w-3 h-3" /> Database: slower</span>
                </>
            )}
            caption={(
                <>
                    {inForce && <span className="block">{narrate(inForce, phase)}</span>}
                    {staged && <>{' '}<span className="block font-medium text-indigo-700 dark:text-indigo-300">With your change: {narrate(staged, phase)}</span></>}
                </>
            )}
        >
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="presentation">
                <div className="w-[7.5rem] shrink-0 sm:w-40">
                    <div className="h-7" />
                    {choices.map((c) => (
                        <div key={c.id} className={cn(ROW, 'flex flex-col justify-center pr-2')}>
                            <span className="text-xs font-semibold leading-snug text-ink">{c.title}</span>
                            {inForce?.id === c.id && <span className="text-[10px] font-medium text-ink-secondary">In force</span>}
                            {staged?.id === c.id && <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">Your change</span>}
                        </div>
                    ))}
                </div>
                {PHASES.map((p, i) => (
                    <div key={p.when} className="relative min-w-[5.5rem] flex-1">
                        {phase === i && (
                            <motion.div layoutId={`${id}-phase`} transition={transition} aria-hidden
                                className="absolute inset-0 rounded-xl border border-ink/10 bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.06)] dark:border-white/10" />
                        )}
                        <div className={cn('relative flex h-7 items-center justify-center text-[10.5px] font-semibold uppercase tracking-[0.08em]',
                            phase === i ? 'text-ink' : 'text-ink-secondary')}>
                            {p.label}
                        </div>
                        {choices.map((c) => {
                            const f = c.frames.find((x) => x.when === p.when)
                            if (!f) return <div key={c.id} className={ROW} />
                            const t = tone(c, f)
                            const Source = f.source === 'database' ? Database : HardDrive
                            return (
                                <div key={c.id} className={cn(ROW, 'relative flex flex-col items-center justify-center gap-1 px-1.5 transition-opacity duration-200 motion-reduce:transition-none',
                                    phase === i ? 'opacity-100' : 'opacity-40')}>
                                    <span className={cn('max-w-full truncate rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-4',
                                        t === 'new' ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                                            : t === 'mix' ? 'bg-gradient-to-r from-slate-500/10 to-emerald-500/20 text-ink-secondary'
                                                : 'bg-slate-500/10 text-ink-secondary')}>
                                        {f.shows}
                                    </span>
                                    <span className={cn('flex items-center gap-1 text-[10px]', f.source === 'database' ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-ink-secondary')}>
                                        <Source aria-hidden className="w-3 h-3" />{f.source}
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
                <Button size="sm" variant="secondary" leftIcon={playing ? Pause : Play}
                    onClick={() => { if (playing) setPlaying(false); else { setPhase(0); setPlaying(true) } }}>
                    {playing ? 'Pause' : 'Play'}
                </Button>
                <Slider
                    className="flex-1"
                    aria-label="Moment"
                    value={phase}
                    onChange={(v) => { setPlaying(false); setPhase(v) }}
                    min={0}
                    max={PHASES.length - 1}
                    step={1}
                    fill={false}
                    format={(v) => PHASES[v].long}
                    ends={false}
                />
            </div>
        </VisualFrame>
    )
}
