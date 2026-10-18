/**
 * The layers of a template, edited as a template: names, order, colours, icons,
 * descriptions and the entity types each column collects. Rules and logical
 * groups authored in a Context View are kept exactly as they were — the canvas
 * is where those are built — and each row says so.
 *
 * Entity types are suggestions for SOME semantic layer: the picker offers the
 * types of every semantic layer this person can read, and accepts any other.
 */
import { useMemo, useState } from 'react'
import { Reorder } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import {
    ChevronDown, ChevronRight, GitBranch, GripVertical, Plus, Trash2, X,
} from 'lucide-react'
import { ColorInput } from '@/components/ui/ColorInput'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { IconPicker } from '@/components/ui/IconPicker'
import { LAYER_COLORS } from '@/components/views/ViewWizard/steps/LayoutStep'
import { caseFold } from '@/features/ontology/lib/caseFold'
import { ontologyListKey } from '@/features/ontology/hooks/useOntologies'
import { entityDefToSchema } from '@/features/ontology/lib/ontology-parsers'
import { cn } from '@/lib/utils'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import { useAnyWorkspacePermission, usePermission } from '@/store/auth'
import type { ViewLayerConfig } from '@/types/schema'
import { newTemplateLayer } from './newTemplateLayer'

interface TypeSuggestion { id: string; name: string; color: string }

/** Every entity type across the semantic layers this person can read — the
 *  same cached list the Semantic Layers page and the Dashboard read. */
function useEntityTypeSuggestions(): TypeSuggestion[] {
    const isAdmin = usePermission('system:admin')
    const canRead = useAnyWorkspacePermission('workspace:ontology:read')
    const { data } = useQuery({
        queryKey: ontologyListKey(false),
        enabled: isAdmin || canRead,
        staleTime: 30_000,
        queryFn: () => ontologyDefinitionService.list(false, false),
    })
    return useMemo(() => {
        const seen = new Map<string, TypeSuggestion>()
        for (const ontology of data ?? []) {
            for (const [id, def] of Object.entries(ontology.entityTypeDefinitions ?? {})) {
                if (seen.has(caseFold(id))) continue
                const s = entityDefToSchema(id, def as Record<string, unknown>)
                seen.set(caseFold(id), { id: s.id, name: s.name, color: s.visual.color })
            }
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    }, [data])
}

function EntityTypeInput({ value, onChange, suggestions }: {
    value: string[]
    onChange: (next: string[]) => void
    suggestions: TypeSuggestion[]
}) {
    const [text, setText] = useState('')
    const chosen = new Set(value.map(caseFold))
    const q = caseFold(text.trim())
    const matches = suggestions
        .filter(s => !chosen.has(caseFold(s.id)) && (!q || caseFold(s.name).includes(q) || caseFold(s.id).includes(q)))
        .slice(0, 8)
    const add = (type: string) => {
        const t = type.trim()
        if (t && !chosen.has(caseFold(t))) onChange([...value, t])
        setText('')
    }
    const nameOf = (id: string) => suggestions.find(s => caseFold(s.id) === caseFold(id))

    return (
        <div>
            <div className="flex flex-wrap gap-1.5 min-h-[28px]">
                {value.map(type => {
                    const known = nameOf(type)
                    return (
                        <span key={type} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs border border-slate-200 dark:border-slate-700 bg-glass-base/40">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: known?.color ?? '#94a3b8' }} />
                            {known?.name ?? type}
                            <button
                                type="button"
                                aria-label={`Remove ${known?.name ?? type}`}
                                onClick={() => onChange(value.filter(t => t !== type))}
                                className="p-0.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    )
                })}
                {value.length === 0 && (
                    <span className="text-xs text-ink-muted italic py-1">None: the column is filled by hand in each view.</span>
                )}
            </div>
            <input
                type="text"
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); add(text) }
                    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
                }}
                placeholder="Add an entity type — Enter to add"
                aria-label="Add an entity type"
                className="input border-slate-200 dark:border-slate-700 mt-2 h-8 w-full text-sm bg-glass-base/40"
            />
            {matches.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {matches.map(s => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => add(s.id)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-ink-muted border border-dashed border-slate-200 dark:border-slate-700 hover:text-ink hover:border-solid"
                        >
                            <Plus className="w-3 h-3" />
                            {s.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

function LayerEditor({ layer, onChange, suggestions }: {
    layer: ViewLayerConfig
    onChange: (patch: Partial<ViewLayerConfig>) => void
    suggestions: TypeSuggestion[]
}) {
    const [iconsOpen, setIconsOpen] = useState(false)
    const rules = layer.rules?.length ?? 0
    const groups = layer.logicalNodes?.length ?? 0
    return (
        <div className="px-4 pb-4 pt-3 space-y-4 border-t border-slate-200 dark:border-slate-700">
            <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
                    <input
                        type="text"
                        value={layer.name}
                        maxLength={80}
                        onChange={e => onChange({ name: e.target.value })}
                        className="input border-slate-200 dark:border-slate-700 mt-1 h-9 w-full text-sm bg-glass-base/40"
                    />
                </label>
                <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Description</span>
                    <input
                        type="text"
                        value={layer.description ?? ''}
                        onChange={e => onChange({ description: e.target.value })}
                        placeholder="What this column holds"
                        className="input border-slate-200 dark:border-slate-700 mt-1 h-9 w-full text-sm bg-glass-base/40"
                    />
                </label>
            </div>
            <div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Entity types</span>
                <div className="mt-1">
                    <EntityTypeInput
                        value={layer.entityTypes ?? []}
                        onChange={entityTypes => onChange({ entityTypes })}
                        suggestions={suggestions}
                    />
                </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Colour</span>
                    <div className="mt-1">
                        <ColorInput value={layer.color ?? LAYER_COLORS[0]} onChange={color => onChange({ color })} />
                    </div>
                </div>
                <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Icon</span>
                    <div className="mt-1 flex items-center gap-2">
                        <span className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center">
                            {layer.icon
                                ? <DynamicIcon name={layer.icon} className="w-4 h-4 text-ink-secondary" />
                                : <span className="text-[10px] text-ink-muted">None</span>}
                        </span>
                        <button
                            type="button"
                            onClick={() => setIconsOpen(o => !o)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 text-ink-secondary hover:text-ink"
                        >
                            {iconsOpen ? 'Done' : 'Choose icon'}
                        </button>
                        {layer.icon && (
                            <button
                                type="button"
                                onClick={() => onChange({ icon: undefined })}
                                className="text-xs text-ink-muted hover:text-ink"
                            >
                                Clear
                            </button>
                        )}
                    </div>
                </div>
            </div>
            {iconsOpen && (
                <IconPicker value={layer.icon ?? ''} onChange={icon => onChange({ icon })} />
            )}
            {(rules > 0 || groups > 0) && (
                <p className="flex items-start gap-2 text-xs text-ink-muted rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2">
                    <GitBranch className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                        Keeps {rules > 0 && `${rules} placement rule${rules === 1 ? '' : 's'}`}
                        {rules > 0 && groups > 0 && ' and '}
                        {groups > 0 && `${groups} logical group${groups === 1 ? '' : 's'}`} as authored on the canvas.
                    </span>
                </p>
            )}
        </div>
    )
}

export function TemplateLayersEditor({ layers, onChange }: {
    layers: ViewLayerConfig[]
    onChange: (layers: ViewLayerConfig[]) => void
}) {
    const suggestions = useEntityTypeSuggestions()
    const [expanded, setExpanded] = useState<string | null>(layers[0]?.id ?? null)
    const commit = (next: ViewLayerConfig[]) => onChange(next.map((l, i) => ({ ...l, order: i })))
    const patch = (id: string, p: Partial<ViewLayerConfig>) => commit(layers.map(l => (l.id === id ? { ...l, ...p } : l)))

    return (
        <div className="space-y-3">
            <Reorder.Group axis="y" values={layers} onReorder={commit} className="space-y-2">
                {layers.map((layer, i) => {
                    const open = expanded === layer.id
                    return (
                        <Reorder.Item
                            key={layer.id}
                            value={layer}
                            className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-canvas-elevated overflow-hidden"
                        >
                            <div className="flex items-center gap-3 px-3 py-2.5">
                                <GripVertical className="w-4 h-4 text-ink-muted cursor-grab shrink-0" aria-hidden />
                                <span className="text-[10px] font-semibold text-ink-muted tabular-nums w-4">{i + 1}</span>
                                <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: layer.color }} />
                                <button
                                    type="button"
                                    aria-expanded={open}
                                    onClick={() => setExpanded(open ? null : layer.id)}
                                    className="flex-1 min-w-0 flex items-center gap-2 text-left"
                                >
                                    <span className={cn('truncate text-sm font-semibold', layer.name.trim() ? 'text-ink' : 'text-red-500')}>
                                        {layer.name.trim() || 'Needs a name'}
                                    </span>
                                    <span className="text-[11px] text-ink-muted shrink-0">
                                        {(layer.entityTypes ?? []).length
                                            ? `${layer.entityTypes.length} type${layer.entityTypes.length === 1 ? '' : 's'}`
                                            : 'filled by hand'}
                                    </span>
                                    {open
                                        ? <ChevronDown className="w-4 h-4 text-ink-muted ml-auto shrink-0" />
                                        : <ChevronRight className="w-4 h-4 text-ink-muted ml-auto shrink-0" />}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`Remove ${layer.name || 'layer'}`}
                                    disabled={layers.length === 1}
                                    onClick={() => commit(layers.filter(l => l.id !== layer.id))}
                                    className="p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                            {open && <LayerEditor layer={layer} onChange={p => patch(layer.id, p)} suggestions={suggestions} />}
                        </Reorder.Item>
                    )
                })}
            </Reorder.Group>
            <button
                type="button"
                disabled={layers.length >= 30}
                onClick={() => {
                    const layer = newTemplateLayer(layers.length)
                    commit([...layers, layer])
                    setExpanded(layer.id)
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 text-sm font-semibold text-ink-muted hover:text-ink hover:border-indigo-400/60 transition-colors disabled:opacity-40"
            >
                <Plus className="w-4 h-4" /> Add layer
            </button>
        </div>
    )
}
