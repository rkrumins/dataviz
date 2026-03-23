import { motion } from 'framer-motion'
import { useSchemaStore } from '@/store/schema'
import * as LucideIcons from 'lucide-react'

// Dynamic icon component (reused locally to avoid excess imports if not shared)
function DynamicIcon({ name, className }: { name: string; className?: string }) {
    const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
    if (!IconComponent) return <LucideIcons.Box className={className} />
    return <IconComponent className={className} />
}

export function NodePalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const schema = useSchemaStore((s) => s.schema)

    const onDragStart = (event: React.DragEvent, nodeType: string) => {
        event.dataTransfer.setData('application/reactflow', nodeType)
        event.dataTransfer.effectAllowed = 'move'
    }

    if (!isOpen) return null

    return (
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="absolute top-20 left-4 z-20 w-64 glass-panel rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[70vh]"
        >
            <div className="p-3 border-b border-glass-border bg-glass-background/50 flex items-center justify-between">
                <h3 className="font-semibold text-sm">Add Node</h3>
                <button onClick={onClose} className="p-1 hover:bg-black/5 rounded">
                    <LucideIcons.X className="w-4 h-4" />
                </button>
            </div>

            <div className="p-3 overflow-y-auto space-y-4 flex-1 custom-scrollbar">
                {schema?.entityTypes.map((type) => (
                    <div key={type.id} className="space-y-2">

                        <div
                            className="flex items-center gap-3 p-3 rounded-lg border border-glass-border bg-canvas-elevated cursor-grab hover:shadow-md transition-all active:cursor-grabbing hover:border-accent-lineage/50"
                            draggable
                            onDragStart={(event) => onDragStart(event, type.id)}
                        >
                            <div
                                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                                style={{ backgroundColor: `${type.visual.color}15` }}
                            >
                                <DynamicIcon
                                    name={type.visual.icon}
                                    className="w-4 h-4"
                                // style={{ color: type.visual.color }}
                                />
                            </div>
                            <div>
                                <div className="text-sm font-medium">{type.name}</div>
                                <div className="text-xs text-ink-muted line-clamp-1">{type.description}</div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <div className="p-2 text-2xs text-center text-ink-muted bg-black/5 border-t border-glass-border">
                Drag items to the canvas
            </div>
        </motion.div>
    )
}
