/**
 * TemplateLayerEditor — wizard-grade layer authoring.
 *
 * Picks a preset to start, then lets the user add/remove/rename layers
 * and adjust ordering. Keeps the scope focused on the metadata that
 * matters at template-authoring time; entity-type assignment happens
 * later, at instantiation, because templates are workspace-agnostic.
 */
import { useCallback } from 'react'
import { Plus, X, ArrowUp, ArrowDown, Sparkles } from 'lucide-react'
import { TEMPLATE_LAYER_PRESETS, type LayerPreset } from './layerPresets'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import type { ViewLayerConfig } from '@/types/schema'
import { cn } from '@/lib/utils'

const DEFAULT_LAYER_COLORS = [
    '#6366f1', '#8B5CF6', '#22C55E', '#F97316', '#06B6D4', '#EC4899', '#A16207', '#64748B',
]

interface TemplateLayerEditorProps {
    layers: ViewLayerConfig[]
    onChange: (next: ViewLayerConfig[]) => void
}

export function TemplateLayerEditor({ layers, onChange }: TemplateLayerEditorProps) {
    const applyPreset = useCallback((preset: LayerPreset) => {
        // Replace whole-cloth — wizard step is "pick a starting point".
        onChange(preset.layers.map(l => ({ ...l })))
    }, [onChange])

    const addLayer = useCallback(() => {
        const idx = layers.length
        const color = DEFAULT_LAYER_COLORS[idx % DEFAULT_LAYER_COLORS.length]
        const next: ViewLayerConfig = {
            id: `layer-${Date.now().toString(36)}`,
            name: `Layer ${idx + 1}`,
            description: '',
            icon: 'Layers',
            color,
            entityTypes: [],
            order: idx,
            sequence: idx,
            showUnassigned: true,
        }
        onChange([...layers, next])
    }, [layers, onChange])

    const removeLayer = useCallback((id: string) => {
        const next = layers
            .filter(l => l.id !== id)
            .map((l, i) => ({ ...l, order: i, sequence: i }))
        onChange(next)
    }, [layers, onChange])

    const updateLayer = useCallback((id: string, patch: Partial<ViewLayerConfig>) => {
        onChange(layers.map(l => l.id === id ? { ...l, ...patch } : l))
    }, [layers, onChange])

    const move = useCallback((id: string, direction: -1 | 1) => {
        const idx = layers.findIndex(l => l.id === id)
        if (idx === -1) return
        const target = idx + direction
        if (target < 0 || target >= layers.length) return
        const next = [...layers]
        ;[next[idx], next[target]] = [next[target], next[idx]]
        onChange(next.map((l, i) => ({ ...l, order: i, sequence: i })))
    }, [layers, onChange])

    return (
        <div className="space-y-5">
            {/* Preset gallery */}
            <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />
                    Start from a preset
                </h4>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                    {TEMPLATE_LAYER_PRESETS.map(preset => (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => applyPreset(preset)}
                            className="group text-left p-3 rounded-lg border border-glass-border hover:border-accent-lineage/40 hover:bg-accent-lineage/5 transition-all"
                        >
                            <div className="flex items-center gap-2 mb-1">
                                <div
                                    className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                                    style={{
                                        backgroundColor: `${preset.accentColor}15`,
                                        color: preset.accentColor,
                                    }}
                                >
                                    <DynamicIcon name={preset.icon} className="w-3 h-3" />
                                </div>
                                <span className="text-sm font-medium text-ink truncate">{preset.name}</span>
                            </div>
                            <p className="text-[11px] text-ink-muted leading-snug line-clamp-2">{preset.description}</p>
                        </button>
                    ))}
                </div>
            </div>

            {/* Layer list */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                        Layers ({layers.length})
                    </h4>
                    <button
                        type="button"
                        onClick={addLayer}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-accent-lineage hover:bg-accent-lineage/5 rounded-md transition-colors"
                    >
                        <Plus className="w-3 h-3" />
                        Add layer
                    </button>
                </div>

                {layers.length === 0 ? (
                    <div className="p-6 text-center rounded-lg border border-dashed border-glass-border">
                        <p className="text-sm text-ink-muted">
                            Pick a preset above, or click <strong>Add layer</strong> to start from scratch.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {layers.map((layer, idx) => (
                            <div
                                key={layer.id}
                                className="flex items-center gap-2 p-2.5 rounded-lg border border-glass-border bg-canvas hover:border-accent-lineage/30 transition-colors"
                            >
                                <div
                                    className="w-7 h-7 rounded flex items-center justify-center shrink-0"
                                    style={{
                                        backgroundColor: `${layer.color ?? '#6366f1'}15`,
                                        color: layer.color ?? '#6366f1',
                                    }}
                                >
                                    <DynamicIcon name={layer.icon ?? 'Layers'} className="w-3.5 h-3.5" />
                                </div>
                                <input
                                    type="text"
                                    value={layer.name}
                                    onChange={(e) => updateLayer(layer.id, { name: e.target.value })}
                                    className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent border border-transparent focus:border-glass-border focus:bg-canvas-elevated rounded text-ink focus:outline-none"
                                />
                                <input
                                    type="color"
                                    value={layer.color ?? '#6366f1'}
                                    onChange={(e) => updateLayer(layer.id, { color: e.target.value })}
                                    title="Layer color"
                                    className="w-6 h-6 rounded cursor-pointer border-0 bg-transparent"
                                />
                                <div className="flex items-center gap-0.5">
                                    <IconButton
                                        title="Move up"
                                        disabled={idx === 0}
                                        onClick={() => move(layer.id, -1)}
                                    >
                                        <ArrowUp className="w-3 h-3" />
                                    </IconButton>
                                    <IconButton
                                        title="Move down"
                                        disabled={idx === layers.length - 1}
                                        onClick={() => move(layer.id, 1)}
                                    >
                                        <ArrowDown className="w-3 h-3" />
                                    </IconButton>
                                    <IconButton
                                        title="Remove layer"
                                        onClick={() => removeLayer(layer.id)}
                                        danger
                                    >
                                        <X className="w-3 h-3" />
                                    </IconButton>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function IconButton({
    children, onClick, disabled, danger, title,
}: {
    children: React.ReactNode
    onClick: () => void
    disabled?: boolean
    danger?: boolean
    title?: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            className={cn(
                'w-6 h-6 inline-flex items-center justify-center rounded transition-colors',
                disabled
                    ? 'text-ink-muted/40 cursor-not-allowed'
                    : danger
                        ? 'text-ink-muted hover:text-red-500 hover:bg-red-500/5'
                        : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
            )}
        >
            {children}
        </button>
    )
}
