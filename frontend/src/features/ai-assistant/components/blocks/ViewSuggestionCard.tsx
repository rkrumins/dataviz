/**
 * ViewSuggestionCard — views that answer the question, each with why it was chosen, where it
 * lives, and Open.
 */
import { ArrowUpRight, Eye, LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewsData } from '../../api/types'
import { useAssistantActions } from '../../lib/useAssistantActions'
import { CardShell } from './parts'

export function ViewSuggestionCard({ data }: { data: ViewsData }) {
    const actions = useAssistantActions()
    const n = data.items.length
    return (
        <CardShell icon={LayoutGrid} title={n === 0 ? 'No matching views' : n === 1 ? 'One view' : `${n} views`}
                   meta={n > 0 ? 'Chosen for what they’re about, not only their names' : undefined}>
            {n === 0 ? (
                <p className="text-sm text-ink-muted">Nothing in the views you can open matches this.</p>
            ) : (
                <ul className="space-y-2">
                    {data.items.map((v) => (
                        <li key={v.id} className="rounded-lg border border-glass-border p-2.5 transition-colors hover:border-accent-lineage/30">
                            <div className="flex items-start gap-2">
                                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-lineage/10 text-accent-lineage">
                                    <Eye className="h-3.5 w-3.5" aria-hidden />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-semibold text-ink">{v.name}</div>
                                    {(v.workspaceName || v.dataSourceName) && (
                                        <div className="truncate text-xs text-ink-muted">
                                            {[v.workspaceName, v.dataSourceName].filter(Boolean).join(' · ')}
                                        </div>
                                    )}
                                </div>
                                <Button size="sm" variant="secondary" rightIcon={ArrowUpRight} onClick={() => actions.openView(v.id)}
                                        aria-label={`Open ${v.name}`}>
                                    Open
                                </Button>
                            </div>
                            {v.description && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-secondary">{v.description}</p>}
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                                {v.reason && <span className="rounded-full bg-accent-lineage/10 px-2 py-0.5 text-accent-lineage">{v.reason}</span>}
                                {(v.tags ?? []).slice(0, 4).map((t) => (
                                    <span key={t} className="rounded-full border border-glass-border px-2 py-0.5">#{t}</span>
                                ))}
                                {v.updatedAt && <span>Updated {timeAgo(v.updatedAt)}</span>}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </CardShell>
    )
}
