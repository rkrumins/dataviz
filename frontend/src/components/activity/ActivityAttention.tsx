/**
 * What in the selection deserves a second look — said in a sentence, with the
 * one click that shows it.
 *
 * Read from the same summary as the band below it, so it describes the
 * selection on screen, and only from facts the summary holds: a source people
 * keep operating by hand, a source only one person ever operates, manual work
 * rising sharply, changes that mostly do not say why. With nothing to say it
 * renders nothing: a callout that is always there is one nobody reads.
 */
import { ArrowRight, Hand, MessageSquareQuote, TrendingUp, UserRound, type LucideIcon } from 'lucide-react'

import type { AttentionItem, AttentionKind } from './attention'
import type { ActivityParamPatch } from './useActivityParams'

const ICONS: Record<AttentionKind, LucideIcon> = {
    toil: Hand,
    'one-person': UserRound,
    surge: TrendingUp,
    reasons: MessageSquareQuote,
}

export function ActivityAttention({ items, onShow }: {
    items: AttentionItem[]
    onShow: (patch: ActivityParamPatch) => void
}) {
    if (items.length === 0) return null
    return (
        <section aria-labelledby="activity-attention">
            <h3 id="activity-attention" className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                Needs attention
            </h3>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => {
                    const Icon = ICONS[item.kind]
                    return (
                        <li key={item.id}>
                            <button
                                type="button"
                                onClick={() => onShow(item.show)}
                                className="group flex h-full w-full items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-left transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                            >
                                <span aria-hidden className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                    <Icon className="h-3.5 w-3.5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-semibold text-ink">{item.title}</span>
                                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-secondary">{item.detail}</span>
                                </span>
                                <ArrowRight aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-amber-600 dark:group-hover:text-amber-400" />
                            </button>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
