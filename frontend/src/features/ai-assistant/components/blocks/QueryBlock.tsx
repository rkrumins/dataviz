/**
 * QueryBlock — a query the assistant wrote, to read before using: Advanced Search's own text
 * form of it (or the Cypher), what it means, what it assumed, and how many it finds. A search
 * opens in Advanced Search; Cypher opens in the Cypher tab's console, where the person presses
 * Run — the assistant never runs it.
 */
import { AlertTriangle, Check, CheckCircle2, Copy, Search, SquareTerminal, Terminal } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { stringifyPredicate } from '@/components/canvas/search/panel/predicateDsl'
import { exact } from '@/lib/formatMetric'
import type { QueryData } from '../../api/types'
import { useAssistantActions } from '../../lib/useAssistantActions'
import { useCopy } from '../../lib/useCopy'
import { Caveats, CardShell, type Caveat } from './parts'

export function QueryBlock({ data }: { data: QueryData }) {
    const actions = useAssistantActions()
    const [copied, copy] = useCopy()
    const cypher = data.language === 'cypher'
    const text = cypher ? data.cypher ?? '' : stringifyPredicate(data.predicate ?? null)
    const guard = data.guard
    const count = typeof data.count === 'number' ? `${exact(data.count)}${data.countExact === false ? '+' : ''}` : null

    const caveats: Caveat[] = [
        ...(data.assumptions ?? []).map((a) => ({ tone: 'info' as const, text: <>Assumed {a}</> })),
        ...(cypher && guard ? [guard.ok
            ? { tone: 'ok' as const, text: 'Checked: it only reads. You run it yourself, in the Cypher tab.' }
            : { tone: 'warning' as const, text: guard.message }] : []),
        ...(count !== null && data.countExact === false ? [{ tone: 'warning' as const, text: 'The count is a floor — it stopped before the end.' }] : []),
    ]

    return (
        <CardShell
            icon={cypher ? Terminal : Search}
            tone="violet"
            title={cypher ? 'Cypher query' : 'Search query'}
            meta={count !== null ? <><span className="font-semibold tabular-nums text-ink">{count}</span> {data.count === 1 ? 'match' : 'matches'}</> : undefined}
            aside={<Badge tone="accent" variant="soft">AI-drafted</Badge>}
            footer={(
                <>
                    {!cypher && data.predicate && data.viewId && (
                        <Button size="sm" variant="primary" leftIcon={Search} onClick={() => actions.openSearch(data.viewId!, data.predicate!)}>
                            Open in Advanced Search
                        </Button>
                    )}
                    {cypher && data.cypher && data.viewId && (
                        <Button size="sm" variant="primary" leftIcon={SquareTerminal} onClick={() => actions.openCypher(data.viewId!, data.cypher!)}>
                            Open in Cypher tab
                        </Button>
                    )}
                    {text && (
                        <Button size="sm" variant="ghost" leftIcon={copied ? Check : Copy} onClick={() => copy(text)}>
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    )}
                </>
            )}
        >
            {data.explanation && <p className="text-sm leading-relaxed text-ink">{data.explanation}</p>}
            {text && (
                <pre aria-label={cypher ? 'Cypher' : 'Search, as text'}
                     className="max-h-56 overflow-auto custom-scrollbar whitespace-pre-wrap break-words rounded-lg border border-glass-border bg-black/[0.03] px-3 py-2 font-mono text-xs leading-relaxed text-ink dark:bg-white/[0.04]">
                    {text}
                </pre>
            )}
            {cypher && guard && guard.ok && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Read-only
                </p>
            )}
            {cypher && guard && !guard.ok && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> It would be refused as written
                </p>
            )}
            <Caveats items={caveats} />
        </CardShell>
    )
}
