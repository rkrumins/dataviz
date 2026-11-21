/**
 * DocCitationList — the passages an answer rests on, numbered as the answer cites them ([1],
 * [2]). The product's own guide and docs open in the app; anything from an external knowledge
 * source says where it came from, so it is never mistaken for the product's word.
 */
import { ArrowUpRight, BookOpen, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CitationsData } from '../../api/types'
import { useAssistantActions } from '../../lib/useAssistantActions'
import { CardShell } from './parts'

export function DocCitationList({ data, anchorPrefix }: { data: CitationsData; anchorPrefix?: string }) {
    const actions = useAssistantActions()
    if (data.items.length === 0) return null
    return (
        <CardShell icon={BookOpen} tone="emerald" title="Sources" meta={`${data.items.length} cited`}>
            <ol className="space-y-1.5">
                {data.items.map((c) => {
                    const external = c.trust === 'external'
                    const inApp = !!c.href && c.href.startsWith('/')
                    const Arrow = inApp ? ArrowUpRight : ExternalLink
                    const body = (
                        <>
                            <span className={cn('mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-2xs font-bold tabular-nums',
                                external ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>
                                {c.n}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1 text-sm font-medium text-ink">
                                    <span className="truncate">{c.title}</span>
                                    {c.href && <Arrow className="h-3 w-3 shrink-0 text-ink-muted" aria-hidden />}
                                </span>
                                {c.section && <span className="block truncate text-xs text-ink-muted">{c.section}</span>}
                                {c.snippet && <span className="mt-0.5 block line-clamp-2 text-xs leading-relaxed text-ink-secondary">{c.snippet}</span>}
                                <span className={cn('mt-1 inline-block rounded-full px-1.5 py-px text-2xs font-semibold',
                                    external ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-black/[0.05] text-ink-muted dark:bg-white/[0.07]')}>
                                    {external ? `From ${c.source}` : c.source === 'docs' ? 'Product docs' : 'User guide'}
                                </span>
                            </span>
                        </>
                    )
                    return (
                        <li key={c.n} id={anchorPrefix ? `${anchorPrefix}-cite-${c.n}` : undefined} className="scroll-mt-4">
                            {c.href ? (
                                <button type="button" onClick={() => actions.openDoc(c.href!)}
                                        className="flex w-full items-start gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.04]">
                                    {body}
                                </button>
                            ) : (
                                <div className="flex items-start gap-2 p-1.5">{body}</div>
                            )}
                        </li>
                    )
                })}
            </ol>
        </CardShell>
    )
}
