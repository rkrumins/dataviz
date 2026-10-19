/**
 * "Preview with real data": while a template is being shaped, its columns
 * filled with a few real entities from a workspace's data — matched to that
 * data's semantic layer and placed the way a view built from it would place
 * them (`livePreview`). Collapsed until asked for; it reads nothing before.
 */
import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { ChevronDown, ScanEye } from 'lucide-react'
import { Skeleton } from '@/components/ui/Skeleton'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useWorkspaceEntityTypes } from '@/hooks/useWorkspaceEntityTypes'
import { cn } from '@/lib/utils'
import type { GraphNode } from '@/providers/GraphDataProvider'
import { getOrCreateProvider } from '@/providers/providerPool'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { useFeature } from '@/store/features'
import { useWorkspacesStore } from '@/store/workspaces'
import type { ViewLayerConfig } from '@/types/schema'
import { placeSample, sampleTypes } from './livePreview'
import { fitTemplate } from './templateFit'
import { primarySource, useFitWorkspaces } from './useTemplateFits'

/** Entities asked for per entity type. */
const SAMPLE = 6
const NEUTRAL = '#94a3b8'

export function TemplateLivePreview({ layers }: { layers: readonly ViewLayerConfig[] }) {
    const choices = useFitWorkspaces()
    const [open, setOpen] = useState(false)
    if (choices.length === 0) return null
    return (
        <section className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
            >
                <ScanEye className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                <span className="text-sm font-semibold text-ink">Preview with real data</span>
                <span className="text-xs text-ink-muted hidden sm:inline">A few real entities in each layer</span>
                <ChevronDown className={cn('ml-auto w-4 h-4 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
            {open && <PreviewBody layers={layers} choices={choices} />}
        </section>
    )
}

function PreviewBody({ layers, choices }: { layers: readonly ViewLayerConfig[]; choices: WorkspaceResponse[] }) {
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const [picked, setPicked] = useState<string | null>(null)
    const workspace = choices.find(ws => ws.id === (picked ?? activeWorkspaceId)) ?? choices[0]
    const source = primarySource(workspace)
    const settled = useDebouncedValue(layers, 400)
    const schema = useWorkspaceEntityTypes(workspace.id, source?.id)
    const fit = useMemo(() => (schema.types ? fitTemplate(settled, schema.types) : null), [settled, schema.types])
    const sampled = useMemo(() => (fit ? sampleTypes(fit.layers) : []), [fit])
    const contract = useFeature('placementContractEnabled')
    const pages = useQueries({
        queries: sampled.map(type => ({
            queryKey: ['layout-template-preview', workspace.id, source?.id ?? '', type],
            queryFn: () => getOrCreateProvider(workspace.id, source!.id).getNodesPage({ entityTypes: [type], limit: SAMPLE }),
            enabled: !!source,
            staleTime: 60_000,
            retry: 1,
        })),
    })
    const loading = schema.isLoading || pages.some(p => p.isLoading)
    const failed = schema.isError || pages.some(p => p.isError)
    const totals = new Map(sampled.map((type, i) => [type, pages[i]?.data?.totalCount ?? null]))
    const placed = fit ? placeSample(fit.layers, pages.flatMap(p => p.data?.nodes ?? []), contract) : null

    return (
        <div className="border-t border-slate-200 dark:border-slate-700 p-4 space-y-3 bg-black/[0.015] dark:bg-white/[0.02]">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                {choices.length > 1 ? (
                    <label className="flex items-center gap-2 whitespace-nowrap">
                        Data from
                        <select
                            value={workspace.id}
                            onChange={e => setPicked(e.target.value)}
                            aria-label="Preview with data from"
                            className="input border-slate-200 dark:border-slate-700 h-8 text-xs bg-canvas-elevated"
                        >
                            {choices.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                        </select>
                    </label>
                ) : (
                    <span>Data from <span className="font-semibold text-ink">{workspace.name}</span></span>
                )}
                {fit && fit.typedLayers > 0 && (
                    <span>· matches {fit.matchedLayers} of {fit.typedLayers} layer{fit.typedLayers === 1 ? '' : 's'}</span>
                )}
            </div>

            {failed ? (
                <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
                    Couldn't read entities from {workspace.name} just now. The template isn't affected.
                </p>
            ) : (
                <div className="flex gap-3 overflow-x-auto pb-1 custom-scrollbar">
                    {(fit?.layers ?? settled).map(layer => (
                        <PreviewColumn
                            // A fitted layer's id is minted afresh; the template layer it came from is stable.
                            key={layer.templateLayerId ?? layer.id}
                            layer={layer}
                            nodes={placed?.byLayer.get(layer.id) ?? []}
                            totals={totals}
                            loading={loading}
                        />
                    ))}
                </div>
            )}

            {fit && fit.unmatchedTypes.length > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Not in {workspace.name}'s semantic layer: {fit.unmatchedTypes.join(', ')}. Views there fill those layers by hand.
                </p>
            )}
        </div>
    )
}

function PreviewColumn({ layer, nodes, totals, loading }: {
    layer: ViewLayerConfig
    nodes: GraphNode[]
    totals: Map<string, number | null>
    loading: boolean
}) {
    const types = layer.entityTypes ?? []
    return (
        <div
            role="group"
            aria-label={layer.name}
            className="w-48 shrink-0 flex flex-col rounded-xl border border-slate-200 dark:border-slate-700 border-t-[3px] bg-canvas-elevated"
            style={{ borderTopColor: layer.color || NEUTRAL }}
        >
            <div className="px-3 pt-2 pb-1.5 text-xs font-bold text-ink truncate">{layer.name}</div>
            <ul className="px-2 space-y-1 min-h-[3.5rem] flex-1">
                {loading && nodes.length === 0 && types.length > 0
                    ? Array.from({ length: 3 }).map((_, i) => <li key={i}><Skeleton className="h-6 rounded-lg" /></li>)
                    : nodes.map(node => (
                        <li key={node.urn} className="truncate rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-[11px] text-ink-secondary">
                            {node.displayName || node.urn}
                        </li>
                    ))}
                {!loading && nodes.length === 0 && (
                    <li className="px-1 py-1 text-[11px] italic text-ink-muted">
                        {types.length ? 'No entities of its types yet' : 'Filled by hand in each view'}
                    </li>
                )}
            </ul>
            <div className="px-3 py-1.5 mt-1 border-t border-slate-100 dark:border-slate-800 text-[10px] text-ink-muted space-y-0.5">
                {types.length === 0 ? <span>No entity types</span> : types.map(type => {
                    const shown = nodes.filter(n => n.entityType === type).length
                    const total = totals.get(type)
                    return (
                        <div key={type} className="truncate tabular-nums">
                            {type}: {total != null ? `${shown} of ~${total.toLocaleString()}` : shown}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
