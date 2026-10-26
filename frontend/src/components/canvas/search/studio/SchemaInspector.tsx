/**
 * SchemaInspector — what the view holds, counted exactly: its types, tags
 * and properties (and their commonest values). A click adds it to the
 * query — a type to what it finds, a tag, a property it has, a value it
 * equals; in Cypher, it copies the label or property to write with.
 */
import { Check, ChevronRight, Copy } from 'lucide-react'
import { useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { useEntityTypeLabel, useEntityVisual } from '@/hooks/useEntityVisual'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import type { EditorMode } from '../panel/builderMode'
import { andWith, listedClauses, withSubject } from '../panel/sentence/clauseModel'


type Tab = 'types' | 'tags' | 'properties'

const TABS: { value: Tab; label: string }[] = [
    { value: 'types', label: 'Types' },
    { value: 'tags', label: 'Tags' },
    { value: 'properties', label: 'Properties' },
]

const ITEM = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.05]'


export function SchemaInspector({ viewId, draft, onRefine, mode, initialTab = 'types' }: {
    viewId: string
    draft: Predicate | null
    onRefine: (next: Predicate) => void
    mode: EditorMode
    initialTab?: Tab
}) {
    const [tab, setTab] = useState<Tab>(initialTab)
    const [copied, setCopied] = useState<string | null>(null)
    const { catalog, reading, unavailable } = usePropertyCatalog(viewId)
    const cypher = mode === 'cypher'

    /** Add it to the query — or, writing Cypher, copy what to write. */
    const use = (next: () => Predicate | null, text: string) => {
        if (cypher) {
            void navigator.clipboard?.writeText(text)
            setCopied(text)
            return
        }
        const p = next()
        if (p) onRefine(p)
    }
    const subjectTypes = listedClauses(draft).subject?.types ?? []

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Segmented options={TABS} value={tab} onChange={setTab} label="What to inspect" size="sm" />
            <p className="text-xs text-ink-muted">
                {cypher ? 'Click to copy it for your Cypher.' : 'Click to add it to the query.'}
                {copied && <span className="ml-1 inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" aria-hidden /> copied {copied}</span>}
            </p>
            {unavailable ? (
                <p className="text-sm text-ink-muted">Exact counts aren't available for this view.</p>
            ) : !catalog ? (
                <div className="flex flex-col gap-1.5">
                    {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7 w-full rounded-lg" />)}
                </div>
            ) : (
                <div role="list" aria-label={`The view's ${tab}`} className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                    {reading !== null && (
                        <p className="px-2 pb-1 text-2xs text-ink-muted">Counting… {reading}%</p>
                    )}
                    {tab === 'types' && (catalog.entityTypes ?? []).map((t) => (
                        <TypeItem key={t.type} type={t.type} count={t.count} cypher={cypher}
                                  onUse={() => use(() => (subjectTypes.includes(t.type) ? null
                                      : withSubject(draft, [...subjectTypes, t.type])), `:${t.type}`)} />
                    ))}
                    {tab === 'tags' && (catalog.tags ?? []).map((t) => (
                        <div key={t.tag} role="listitem">
                            <button type="button" className={ITEM}
                                    onClick={() => use(() => andWith(draft, { kind: 'tag', op: 'hasAny', values: [t.tag] }),
                                        `'${t.tag}' IN n.tags`)}>
                                <span className="min-w-0 flex-1 truncate text-ink">#{t.tag}</span>
                                <Count n={t.count} />
                            </button>
                        </div>
                    ))}
                    {tab === 'properties' && (catalog.properties ?? []).map((p) => (
                        <PropertyItem key={p.key} name={p.key} count={p.count} cypher={cypher}
                                      values={(p.values ?? []).slice(0, 8)}
                                      onKey={() => use(() => andWith(draft, { kind: 'hasProperty', key: p.key, negate: false }),
                                          `n.\`${p.key}\``)}
                                      onValue={(value) => use(() => andWith(draft,
                                          { kind: 'property', key: p.key, op: 'eq', value } as Predicate),
                                          `n.\`${p.key}\` = ${JSON.stringify(value)}`)} />
                    ))}
                </div>
            )}
        </div>
    )
}


function Count({ n }: { n: number }) {
    return <span className="shrink-0 text-xs tabular-nums text-ink-muted">{n.toLocaleString()}</span>
}


function TypeItem({ type, count, cypher, onUse }: { type: string; count: number; cypher: boolean; onUse: () => void }) {
    const visual = useEntityVisual(type)
    const label = useEntityTypeLabel(type) ?? type
    return (
        <div role="listitem">
            <button type="button" className={ITEM} onClick={onUse}
                    aria-label={`${cypher ? 'Copy the label' : 'Find'} ${label}: ${count.toLocaleString()}`}>
                <DynamicIcon name={visual.icon} className="h-3.5 w-3.5 shrink-0" style={{ color: visual.color }} />
                <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
                {cypher && <Copy className="h-3 w-3 text-ink-muted" aria-hidden />}
                <Count n={count} />
            </button>
        </div>
    )
}


function PropertyItem({ name, count, values, cypher, onKey, onValue }: {
    name: string
    count: number
    values: ReadonlyArray<{ value: unknown; count: number }>
    cypher: boolean
    onKey: () => void
    onValue: (value: unknown) => void
}) {
    const [open, setOpen] = useState(false)
    return (
        <div role="listitem">
            <div className="flex items-center">
                <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
                        aria-label={`${open ? 'Hide' : 'Show'} the values of ${name}`} disabled={values.length === 0}
                        className="rounded-md p-1 text-ink-muted hover:text-ink disabled:opacity-30">
                    <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
                </button>
                <button type="button" className={ITEM} onClick={onKey}>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{name}</span>
                    {cypher && <Copy className="h-3 w-3 text-ink-muted" aria-hidden />}
                    <Count n={count} />
                </button>
            </div>
            {open && (
                <div className="ml-6 flex flex-col">
                    {values.map((v) => (
                        <button key={String(v.value)} type="button" className={cn(ITEM, 'py-1')} onClick={() => onValue(v.value)}>
                            <span className="min-w-0 flex-1 truncate text-xs text-ink">{String(v.value)}</span>
                            <Count n={v.count} />
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
