/**
 * ResultSummaryCard — what a search found: how many (and whether that is exact), by type, where
 * they sit, the first of them, and what it searched. Show on canvas (when this view's canvas is
 * open), Open in Advanced Search, Copy list.
 */
import { Check, Copy, ListFilter, Search, Telescope } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { exact } from '@/lib/formatMetric'
import type { ResultsData } from '../../api/types'
import { useAssistantActions, useMountedCanvasViewId } from '../../lib/useAssistantActions'
import { useCopy } from '../../lib/useCopy'
import { Caveats, CardShell, EntityChip, EntityList, SectionLabel, TypeBars, type Caveat } from './parts'

export function ResultSummaryCard({ data }: { data: ResultsData }) {
    const actions = useAssistantActions()
    const mounted = useMountedCanvasViewId()
    const [copied, copy] = useCopy()
    const onCanvas = !!data.viewId && mounted === data.viewId
    const predicate = data.query?.predicate
    const total = `${exact(data.total)}${data.totalExact ? '' : '+'}`

    const caveats: Caveat[] = [
        data.totalExact
            ? { tone: 'ok', text: 'Counted exactly.' }
            : { tone: 'warning', text: `At least ${exact(data.total)} — the count stopped before it reached the end.` },
        ...(data.query ? [{
            tone: 'info' as const,
            text: data.query.scopeMode === 'view' ? 'Searched this view only.' : 'Searched the whole data source, not only this view.',
        }] : []),
        ...(data.items.length < data.total ? [{ tone: 'info' as const, text: `Listing the first ${exact(data.items.length)}.` }] : []),
        ...(data.notes ?? []).map((text) => ({ tone: 'info' as const, text })),
    ]

    return (
        <CardShell
            icon={ListFilter}
            title={data.title}
            meta={<><span className="font-semibold tabular-nums text-ink">{total}</span> {data.total === 1 ? 'match' : 'matches'}</>}
            footer={(
                <>
                    {onCanvas && (
                        <Button size="sm" variant="primary" leftIcon={Telescope}
                                onClick={() => (predicate ? actions.openSearch(data.viewId!, predicate)
                                    : actions.reveal(data.viewId, data.items.map((e) => e.urn)))}>
                            Show on canvas
                        </Button>
                    )}
                    {predicate && data.viewId && (
                        <Button size="sm" variant="secondary" leftIcon={Search} onClick={() => actions.openSearch(data.viewId!, predicate)}>
                            Open in Advanced Search
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" leftIcon={copied ? Check : Copy}
                            onClick={() => copy(data.items.map((e) => [e.name, e.type, ...(e.path ?? [])].join('\t')).join('\n'))}>
                        {copied ? 'Copied' : 'Copy list'}
                    </Button>
                </>
            )}
        >
            {data.byType && data.byType.length > 0 && (
                <div>
                    <SectionLabel>By type</SectionLabel>
                    <TypeBars rows={data.byType} />
                </div>
            )}
            {data.byContainer && data.byContainer.length > 0 && (
                <div>
                    <SectionLabel>Where they are</SectionLabel>
                    <ul className="divide-y divide-glass-border/60 rounded-lg border border-glass-border">
                        {data.byContainer.slice(0, 10).map(({ entity, count }) => (
                            <li key={entity.urn} className="flex items-center justify-between gap-2 px-2 py-1.5">
                                <EntityChip entity={entity} viewId={data.viewId} className="border-transparent bg-transparent" />
                                <span className="shrink-0 text-xs font-semibold tabular-nums text-ink">{exact(count)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {data.items.length > 0 && (
                <div>
                    <SectionLabel>{data.items.length < data.total ? `First ${exact(data.items.length)}` : 'All of them'}</SectionLabel>
                    <EntityList items={data.items} viewId={data.viewId} limit={12} total={data.total} />
                </div>
            )}
            <Caveats items={caveats} />
        </CardShell>
    )
}
