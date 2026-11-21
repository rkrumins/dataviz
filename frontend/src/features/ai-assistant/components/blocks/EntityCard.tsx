/**
 * EntityCard — one entity, as the assistant read it: what it is, where it sits, its description,
 * properties and tags, and the way to it on the canvas.
 */
import { useState } from 'react'
import { Telescope } from 'lucide-react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { Button } from '@/components/ui/Button'
import { useEntityTypeLabel, useEntityVisual } from '@/hooks/useEntityVisual'
import type { EntityData } from '../../api/types'
import { useAssistantActions, useMountedCanvasViewId } from '../../lib/useAssistantActions'
import { SectionLabel } from './parts'

const PROPERTY_STEP = 8

const show = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '—' : JSON.stringify(v))

export function EntityCard({ data }: { data: EntityData }) {
    const { entity } = data
    const visual = useEntityVisual(entity.type)
    const typeLabel = useEntityTypeLabel(entity.type) ?? entity.type
    const actions = useAssistantActions()
    const mounted = useMountedCanvasViewId()
    const [all, setAll] = useState(false)
    const properties = data.properties ?? []
    const shown = all ? properties : properties.slice(0, PROPERTY_STEP)

    return (
        <section aria-label={entity.name} className="overflow-hidden rounded-xl border border-glass-border bg-canvas shadow-sm shadow-black/5">
            <header className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3"
                    style={{ background: `linear-gradient(135deg, ${visual.color}14 0%, transparent 70%)` }}>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${visual.color}1f` }}>
                    <DynamicIcon name={visual.icon} className="h-4 w-4" style={{ color: visual.color }} />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 className="break-words text-sm font-semibold text-ink">{entity.name}</h3>
                    <p className="text-xs text-ink-muted">
                        {typeLabel}{entity.path?.length ? ` in ${entity.path.join(' › ')}` : ''}
                    </p>
                </div>
            </header>
            <div className="space-y-3 px-3.5 pb-3.5">
                {data.description && <p className="text-sm leading-relaxed text-ink-secondary">{data.description}</p>}
                {(data.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {data.tags!.map((t) => <span key={t} className="rounded-full border border-glass-border px-2 py-0.5 text-xs text-ink-secondary">#{t}</span>)}
                    </div>
                )}
                {properties.length > 0 && (
                    <div>
                        <SectionLabel aside={properties.length > PROPERTY_STEP && (
                            <button type="button" onClick={() => setAll(!all)} aria-expanded={all}
                                    className="text-xs font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                {all ? 'Show fewer' : `Show all ${properties.length}`}
                            </button>
                        )}>
                            Properties
                        </SectionLabel>
                        <dl className="divide-y divide-glass-border/60 rounded-lg border border-glass-border">
                            {shown.map((p) => (
                                <div key={p.key} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 px-2.5 py-1.5 text-xs">
                                    <dt className="truncate font-mono text-ink-muted">{p.key}</dt>
                                    <dd className="break-words text-ink">{show(p.value)}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                )}
            </div>
            {data.viewId && (
                <footer className="flex items-center gap-1.5 border-t border-glass-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.02]">
                    <Button size="sm" variant="secondary" leftIcon={Telescope} onClick={() => actions.reveal(data.viewId, [entity.urn])}>
                        {mounted === data.viewId ? 'Show on canvas' : 'Open in its view'}
                    </Button>
                </footer>
            )}
        </section>
    )
}
