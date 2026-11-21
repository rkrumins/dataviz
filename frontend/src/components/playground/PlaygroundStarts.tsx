/**
 * PlaygroundStarts — the three ways to start a graph in the Playground, as things to do rather
 * than steps to read: explore a sample, bring your own data, or start blank. Each card is one
 * button; a way that isn't open to the reader (no samples, a switch off) isn't offered, and
 * once every graph is used, none is.
 */
import type { ComponentType } from 'react'
import { ArrowRight, PenTool, UploadCloud, WandSparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

const FULL = 'You’ve used all your graphs — delete one you’re done with to start another.'

interface Start {
    id: 'sample' | 'import' | 'blank'
    tour: string
    title: string
    detail: string
    cta: string
    icon: ComponentType<{ className?: string }>
    tile: string
    onClick?: () => void
}

export function PlaygroundStarts({ first, full, onSample, onImport, onBlank, className }: {
    /** Before the reader's first graph: the starts lead the panel. */
    first: boolean
    /** Every graph of the reader's is used. */
    full: boolean
    onSample?: () => void
    onImport?: () => void
    onBlank?: () => void
    className?: string
}) {
    const starts: Start[] = [
        {
            id: 'sample', tour: 'playground-start-sample', title: 'Start from a sample', cta: 'Pick a sample',
            detail: 'A ready-made graph with views, saved searches and an example review — the quickest way to see what a graph is for.',
            icon: WandSparkles, tile: 'from-amber-400 to-orange-500 shadow-amber-500/25', onClick: onSample,
        },
        {
            id: 'import', tour: 'playground-import', title: 'Bring your own data', cta: 'Choose files',
            detail: 'Your things and how they connect, from CSV or JSON files. Templates included.',
            icon: UploadCloud, tile: 'from-sky-400 to-indigo-500 shadow-sky-500/25', onClick: onImport,
        },
        {
            id: 'blank', tour: 'playground-new-graph', title: 'Start a blank graph', cta: 'Pick a data model',
            detail: 'Pick a starter data model, then draw on the canvas — or bring things in later.',
            icon: PenTool, tile: 'from-violet-500 to-fuchsia-500 shadow-violet-500/25', onClick: onBlank,
        },
    ].filter(s => s.onClick) as Start[]
    if (!starts.length) return null

    return (
        <section aria-labelledby="starts-title" data-tour="playground-starts" className={className}>
            <h3 id="starts-title" className="text-sm font-semibold text-ink">{first ? 'Start your first graph' : 'Start another graph'}</h3>
            <p className="mt-0.5 text-xs text-ink-muted">
                {first
                    ? 'A graph holds your things and how they connect. Explore it in views — a graph, a hierarchy or a context view.'
                    : 'Each one counts as one of your graphs.'}
            </p>
            <ul className={cn('mt-3 grid gap-3', starts.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                {starts.map(s => (
                    <li key={s.id} data-tour={s.tour}>
                        <button
                            type="button"
                            aria-labelledby={`start-${s.id}-title`}
                            aria-describedby={`start-${s.id}-detail`}
                            onClick={s.onClick}
                            disabled={full}
                            title={full ? FULL : undefined}
                            className="group flex h-full w-full items-start gap-3 rounded-2xl border border-glass-border bg-canvas-elevated p-4 text-left shadow-sm transition hover:-translate-y-px hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/10 disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none disabled:hover:border-glass-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:flex-col"
                        >
                            <span className={cn('flex w-10 h-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', s.tile)}>
                                <s.icon className="w-5 h-5" aria-hidden />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col self-stretch">
                                <span id={`start-${s.id}-title`} className="block text-sm font-semibold text-ink">{s.title}</span>
                                <span id={`start-${s.id}-detail`} className="mt-0.5 block flex-1 text-xs leading-snug text-ink-secondary">{s.detail}</span>
                                <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-300">
                                    {s.cta} <ArrowRight className="w-3.5 h-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                                </span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    )
}
