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
    const offered = [onSample, onImport, onBlank].filter(Boolean).length
    if (!offered) return null

    // Each card carries its own tour anchor, written out: the tour's anchor check reads them literally.
    return (
        <section aria-labelledby="starts-title" className={className}>
            <h3 id="starts-title" className="text-sm font-semibold text-ink">{first ? 'Start your first graph' : 'Start another graph'}</h3>
            <p className="mt-0.5 text-xs text-ink-muted">
                {first
                    ? 'A graph holds your things and how they connect. Explore it in views — a graph, a hierarchy or a context view.'
                    : 'Each one counts as one of your graphs.'}
            </p>
            <ul className={cn('mt-3 grid gap-3', offered === 3 ? 'sm:grid-cols-3' : offered === 2 && 'sm:grid-cols-2')}>
                {onSample && (
                    <li data-tour="playground-start-sample">
                        <StartCard id="sample" full={full} onClick={onSample} icon={WandSparkles} tile="from-amber-400 to-orange-500 shadow-amber-500/25"
                            title="Start from a sample" cta="Pick a sample"
                            detail="A ready-made graph with views, saved searches and an example review — the quickest way to see what a graph is for." />
                    </li>
                )}
                {onImport && (
                    <li data-tour="playground-import">
                        <StartCard id="import" full={full} onClick={onImport} icon={UploadCloud} tile="from-sky-400 to-indigo-500 shadow-sky-500/25"
                            title="Bring your own data" cta="Choose files"
                            detail="Your own data source from a file — simple CSVs, JSON or a standard import file — on an approved semantic layer or one of your own." />
                    </li>
                )}
                {onBlank && (
                    <li data-tour="playground-new-graph">
                        <StartCard id="blank" full={full} onClick={onBlank} icon={PenTool} tile="from-violet-500 to-fuchsia-500 shadow-violet-500/25"
                            title="Start a blank graph" cta="Pick a data model"
                            detail="Pick a data model — an approved one or your own — then draw on the canvas, or bring things in later." />
                    </li>
                )}
            </ul>
        </section>
    )
}

function StartCard({ id, title, detail, cta, icon: Icon, tile, full, onClick }: {
    id: string
    title: string
    detail: string
    cta: string
    icon: ComponentType<{ className?: string }>
    tile: string
    full: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            aria-labelledby={`start-${id}-title`}
            aria-describedby={`start-${id}-detail`}
            onClick={onClick}
            disabled={full}
            title={full ? FULL : undefined}
            className="group flex h-full w-full items-start gap-3 rounded-2xl border border-glass-border bg-canvas-elevated p-4 text-left shadow-sm transition hover:-translate-y-px hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/10 disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none disabled:hover:border-glass-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:flex-col"
        >
            <span className={cn('flex w-10 h-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', tile)}>
                <Icon className="w-5 h-5" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col self-stretch">
                <span id={`start-${id}-title`} className="block text-sm font-semibold text-ink">{title}</span>
                <span id={`start-${id}-detail`} className="mt-0.5 block flex-1 text-xs leading-snug text-ink-secondary">{detail}</span>
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-300">
                    {cta} <ArrowRight className="w-3.5 h-3.5 transition group-hover:translate-x-0.5" aria-hidden />
                </span>
            </span>
        </button>
    )
}
