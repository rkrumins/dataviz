/**
 * Getting a new workspace ready, step by step — ticked from what is really there.
 *
 * The empty Data Sources tab used to print "1 Add a source · 2 Assign ontology ·
 * 3 Run aggregation · 4 Create views" as static text: it never ticked, never
 * linked, and stayed the same once the work was done. This list reads the
 * workspace itself, offers each next step as a button, says how far along it is,
 * and goes away once everything is done (or when its reader dismisses it).
 */
import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SetupStep {
    id: string
    label: string
    description: string
    done: boolean
    actionLabel?: string
    onAction?: () => void
}

const dismissKey = (wsId: string) => `nx-workspace-setup-dismissed:${wsId}`

function readDismissed(wsId: string): boolean {
    try { return window.localStorage.getItem(dismissKey(wsId)) === '1' } catch { return false }
}

export function SetupChecklist({ wsId, steps }: { wsId: string; steps: SetupStep[] }) {
    const [dismissed, setDismissed] = useState(() => readDismissed(wsId))
    const done = steps.filter(s => s.done).length
    if (dismissed || done === steps.length) return null
    const next = steps.find(s => !s.done)
    const pct = Math.round((done / steps.length) * 100)

    const dismiss = () => {
        setDismissed(true)
        try { window.localStorage.setItem(dismissKey(wsId), '1') } catch { /* this browser keeps no state */ }
    }

    return (
        <section aria-labelledby="setup-title" className="relative overflow-hidden rounded-3xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/[0.06] via-violet-500/[0.04] to-transparent p-5">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 id="setup-title" className="text-sm font-bold text-ink">Get this workspace ready</h2>
                    <p className="mt-0.5 text-xs text-ink-muted">{done} of {steps.length} done · people can start exploring once there’s a view</p>
                </div>
                <button type="button" onClick={dismiss} aria-label="Hide the setup checklist" className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="mt-3 h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>

            <ol className="mt-4 space-y-1.5">
                {steps.map((s, i) => {
                    const isNext = s.id === next?.id
                    return (
                        <li key={s.id} className={cn('flex items-center gap-3 rounded-2xl px-3 py-2', isNext && 'bg-canvas-elevated border border-glass-border shadow-sm')}>
                            <span
                                className={cn(
                                    'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0',
                                    s.done ? 'bg-emerald-500 text-white' : isNext ? 'bg-indigo-500 text-white' : 'bg-black/[0.06] dark:bg-white/[0.08] text-ink-muted',
                                )}
                                aria-hidden
                            >
                                {s.done ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : i + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className={cn('block text-sm font-semibold', s.done ? 'text-ink-muted line-through decoration-ink-muted/40' : 'text-ink')}>
                                    {s.label}<span className="sr-only">{s.done ? ' — done' : ''}</span>
                                </span>
                                {isNext && <span className="block text-xs text-ink-muted">{s.description}</span>}
                            </span>
                            {isNext && s.onAction && s.actionLabel && (
                                <button
                                    type="button"
                                    onClick={s.onAction}
                                    className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 shrink-0"
                                >
                                    {s.actionLabel}
                                </button>
                            )}
                        </li>
                    )
                })}
            </ol>
        </section>
    )
}
