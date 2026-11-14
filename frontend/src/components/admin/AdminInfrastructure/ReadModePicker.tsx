/**
 * ReadModePicker — choose what a graph's readers get while a newer version of it lands, in the
 * reader's terms. Each mode is a card: its promise, a timeline of what readers see before, while
 * and after version 6 lands, a worked example on a large graph, what it is good for, its trade-offs
 * and what it needs. One that can't be chosen says why. For a single graph, a first option uses the
 * platform's default, naming it.
 */
import type { ReactNode } from 'react'
import { Check, CornerDownRight, Database, HardDrive } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReadMode } from '@/services/systemStatusService'
import { READ_MODE, READ_MODES, type ReadFrame } from './readModes'

const VERSION_PILL: Record<ReadFrame['shows'], { label: string; cls: string }> = {
    '5': { label: 'v5', cls: 'border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-200' },
    '6': { label: 'v6', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
    mix: { label: 'v5 + parts of v6', cls: 'border-sky-500/25 bg-gradient-to-r from-slate-500/10 to-emerald-500/15 text-sky-800 dark:text-sky-200' },
}

/** Before, while and after version 6 lands: the version shown and where it is read from. */
function Timeline({ frames }: { frames: ReadFrame[] }) {
    return (
        <ol aria-label="What readers see" className="grid grid-cols-3 gap-1.5">
            {frames.map(f => {
                const pill = VERSION_PILL[f.shows]
                const Source = f.from === 'database' ? Database : HardDrive
                return (
                    <li key={f.when} className="min-w-0 rounded-lg border border-glass-border bg-canvas/60 px-2 py-1.5">
                        <span className="block text-[9px] font-semibold uppercase tracking-wide text-ink-muted">{f.when}</span>
                        <span className={cn('mt-1 inline-flex px-1.5 py-px rounded-full border text-[10px] font-semibold', pill.cls)}>{pill.label}</span>
                        <span className={cn('mt-1 flex items-center gap-1 text-[9.5px]',
                            f.from === 'database' ? 'text-amber-700 dark:text-amber-400' : 'text-ink-muted')}
                        >
                            <Source className="w-3 h-3 shrink-0" aria-hidden /> {f.from}
                        </span>
                        {f.note && <span className="mt-0.5 block text-[9.5px] leading-snug text-ink-muted">{f.note}</span>}
                    </li>
                )
            })}
        </ol>
    )
}

export interface ReadModePickerProps {
    /** The mode chosen; null uses the platform's (only with ``inheritFrom``). */
    value: ReadMode | null
    onChange: (mode: ReadMode | null) => void
    /** For one graph: the platform's mode, offered first as its default. */
    inheritFrom?: ReadMode
    /** The platform's default, badged "Default" on its card. */
    defaultMode?: ReadMode
    /** Modes that can't be chosen here, with why. */
    unavailable?: Partial<Record<ReadMode, string>>
    /** A note under a mode's card, e.g. what it needs that is not yet on. */
    notes?: Partial<Record<ReadMode, ReactNode>>
    disabled?: boolean
    label?: string
}

export function ReadModePicker({
    value, onChange, inheritFrom, defaultMode, unavailable = {}, notes = {}, disabled = false,
    label = 'What readers get while a new version lands',
}: ReadModePickerProps) {
    return (
        <div role="radiogroup" aria-label={label} className="space-y-2.5">
            {inheritFrom && (
                <button
                    type="button"
                    role="radio"
                    aria-checked={value === null}
                    disabled={disabled}
                    onClick={() => onChange(null)}
                    className={cn(
                        'w-full flex items-center gap-2.5 rounded-xl border-2 px-3.5 py-2.5 text-left transition-colors',
                        value === null ? 'border-indigo-500 bg-indigo-500/5' : 'border-glass-border hover:border-indigo-500/40',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    <CornerDownRight className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-ink">Use the platform default</span>
                        <span className="block text-[11px] text-ink-muted">
                            Currently <span className="font-medium text-ink-secondary">{READ_MODE[inheritFrom].title}</span>. Follows it if an administrator changes it.
                        </span>
                    </span>
                    {value === null && <Check className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />}
                </button>
            )}
            <div className="grid gap-2.5 lg:grid-cols-3">
                {READ_MODES.map(m => {
                    const selected = value === m.mode
                    const why = unavailable[m.mode]
                    const Icon = m.icon
                    return (
                        <div key={m.mode} className="flex flex-col">
                            <button
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={m.title}
                                aria-describedby={`read-mode-${m.mode}-promise`}
                                disabled={disabled || Boolean(why)}
                                onClick={() => onChange(m.mode)}
                                className={cn(
                                    'relative flex-1 flex flex-col gap-2.5 rounded-xl border-2 p-3.5 text-left transition-all',
                                    selected
                                        ? 'border-indigo-500 bg-indigo-500/[0.04] shadow-[0_0_0_4px_rgba(99,102,241,0.08)]'
                                        : 'border-glass-border bg-canvas-elevated/60 hover:border-indigo-500/40',
                                    'disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:border-glass-border',
                                )}
                            >
                                <span className="flex items-start gap-2.5">
                                    <span className={cn('grid place-items-center w-8 h-8 rounded-lg shrink-0',
                                        selected ? 'bg-indigo-500 text-white' : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400')}
                                    >
                                        <Icon className="w-4 h-4" aria-hidden />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-1.5">
                                            <span className="text-[13px] font-semibold text-ink">{m.title}</span>
                                            {defaultMode === m.mode && (
                                                <span className="inline-flex px-1.5 py-px rounded-full border border-indigo-500/20 bg-indigo-500/10 text-[9px] uppercase tracking-wide text-indigo-600 dark:text-indigo-400">Default</span>
                                            )}
                                            {m.mode === 'beside' && (
                                                <span className="inline-flex px-1.5 py-px rounded-full border border-violet-500/20 bg-violet-500/10 text-[9px] uppercase tracking-wide text-violet-600 dark:text-violet-400">Preview</span>
                                            )}
                                        </span>
                                        <span id={`read-mode-${m.mode}-promise`} className="mt-0.5 block text-[11.5px] leading-snug text-ink-secondary">{m.promise}</span>
                                    </span>
                                    {selected && <Check className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />}
                                </span>

                                <Timeline frames={m.frames} />

                                <span className="block rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-2 text-[11px] leading-snug text-ink-secondary">
                                    <span className="font-semibold text-ink">Example. </span>{m.example}
                                </span>

                                <span className="grid gap-1 text-[11px] leading-snug">
                                    {m.pros.map(p => (
                                        <span key={p} className="flex gap-1.5 text-emerald-700 dark:text-emerald-400"><span aria-hidden>✓</span><span>{p}</span></span>
                                    ))}
                                    {m.cons.map(c => (
                                        <span key={c} className="flex gap-1.5 text-amber-700 dark:text-amber-400"><span aria-hidden>!</span><span>{c}</span></span>
                                    ))}
                                </span>

                                <span className="mt-auto block border-t border-glass-border pt-2 text-[10.5px] text-ink-muted">
                                    <span className="font-semibold text-ink-secondary">Good for: </span>{m.goodFor}{' '}
                                    <span className="font-semibold text-ink-secondary">Needs: </span>{m.needs}
                                </span>
                            </button>
                            {why && <p className="mt-1 px-1 text-[10.5px] text-ink-muted">{why}</p>}
                            {!why && notes[m.mode] && <div className="mt-1 px-1 text-[10.5px]">{notes[m.mode]}</div>}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
