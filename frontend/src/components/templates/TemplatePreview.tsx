/**
 * A layout at a glance: up to five columns, each topped with its layer's own
 * colour, and the rest counted. Neutral bodies on purpose — a grid of fully
 * tinted cards reads as noise — so the colour is a thin band, and only the
 * SELECTED card's columns take a soft accent. Hovering a column explains it.
 *
 * Shared by the Templates library, the view wizard's Layout step and the
 * Dashboard, so a template looks the same wherever it is offered.
 */
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

type PreviewLayer = Partial<ViewLayerConfig> & { name: string }

const NEUTRAL = '#94a3b8'

export function TemplatePreview({ layers, active }: { layers: readonly PreviewLayer[]; active?: boolean }) {
    if (layers.length === 0) {
        return (
            <div className="flex items-center justify-center h-[52px] rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-[10px] text-slate-400">
                Empty canvas
            </div>
        )
    }
    const shown = layers.slice(0, 5)
    const extra = layers.length - shown.length
    return (
        <div className="flex items-end gap-1.5">
            {shown.map((layer, i) => (
                <HoverTip
                    key={layer.id ?? i}
                    label={layer.name}
                    detail={layer.description || undefined}
                    className="block flex-1 min-w-0"
                >
                    <div
                        className={cn(
                            'h-8 rounded-md border border-t-[3px]',
                            active
                                ? 'bg-blue-100 border-blue-200 dark:bg-blue-900/40 dark:border-blue-800'
                                : 'bg-slate-100 border-slate-200 dark:bg-slate-700/60 dark:border-slate-600/60',
                        )}
                        style={{ borderTopColor: layer.color || NEUTRAL }}
                    />
                    <div className="mt-1 text-[9px] text-slate-500 dark:text-slate-400 truncate text-center">
                        {layer.name}
                    </div>
                </HoverTip>
            ))}
            {extra > 0 && (
                <div className="flex-none">
                    <div className="h-8 px-1.5 rounded-md bg-slate-100 border border-slate-200 dark:bg-slate-700/60 dark:border-slate-600/60 flex items-center justify-center text-[9px] font-semibold text-slate-500 dark:text-slate-300">
                        +{extra}
                    </div>
                    <div className="mt-1 text-[9px] text-transparent">.</div>
                </div>
            )}
        </div>
    )
}
