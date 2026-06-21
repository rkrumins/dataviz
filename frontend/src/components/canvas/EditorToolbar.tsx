import { Plus, Trash2, X, ChevronDown, Check, Pencil, Spline } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { cn } from '@/lib/utils'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

export interface EditorToolbarProps {
    onAddNode: () => void
    edgeTypes: any[] // RelationshipTypeSchema[]
    activeEdgeType: string
    onSelectEdgeType: (typeId: string) => void
}

/**
 * EditorToolbar — the floating in-canvas authoring helper, shown only in Edit
 * mode (`canvas.isEditing`). It owns the connection-draw toolset that has no
 * equivalent in the header: pick a relationship type, then drag between node
 * handles to draw it; plus Add Node and Delete-selected.
 *
 * Saving is intentionally NOT here — it flows through the header's staged-changes
 * "Save Blueprint" path, the single source of truth for committing edits.
 */
export function EditorToolbar({
    onAddNode,
    edgeTypes = [],
    activeEdgeType,
    onSelectEdgeType
}: EditorToolbarProps) {
    const {
        isEditing,
        setEditing,
        selectedNodeIds,
        selectedEdgeIds,
        removeNode,
        removeEdge,
        clearSelection
    } = useCanvasStore()

    const handleDelete = () => {
        selectedNodeIds.forEach(id => removeNode(id))
        selectedEdgeIds.forEach(id => removeEdge(id))
        clearSelection()
    }

    const hasSelection = selectedNodeIds.length > 0 || selectedEdgeIds.length > 0

    // Get active type label and rules
    const activeType = edgeTypes.find(t => t.id === activeEdgeType)
    const activeLabel = activeType?.name || 'Manual (Default)'

    const getRuleText = () => {
        if (!activeType || activeEdgeType === 'manual') return 'Connect any nodes'
        const sources = activeType.sourceTypes?.join(', ') || 'Any'
        const targets = activeType.targetTypes?.join(', ') || 'Any'
        return `${sources} → ${targets}`
    }

    if (!isEditing) return null

    return (
        <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-2 p-2 rounded-2xl bg-canvas-elevated/90 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40">
                {/* Edit-mode badge — matches the header's "Editing" pill */}
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-amber-400/20 to-orange-500/15 border border-amber-400/50 text-amber-800 dark:text-amber-200 dark:border-amber-300/40">
                    <Pencil className="w-3.5 h-3.5" strokeWidth={2.4} />
                    <span className="text-[11px] font-bold uppercase tracking-[0.08em] leading-none">Editing</span>
                </div>

                {/* Active connection rule */}
                <div className="flex flex-col justify-center px-2.5 min-w-[120px] border-l border-black/[0.08] dark:border-white/[0.06]">
                    <span className="text-[9px] font-semibold text-ink-muted uppercase tracking-wider leading-none mb-0.5">Connection rule</span>
                    <span className="text-[11px] text-accent-lineage truncate max-w-[150px] leading-none" title={getRuleText()}>
                        {getRuleText()}
                    </span>
                </div>

                <div className="w-px h-7 bg-black/[0.08] dark:bg-white/[0.06]" />

                <ToolbarButton
                    icon={<Plus className="w-4 h-4" />}
                    label="Add Node"
                    onClick={onAddNode}
                    variant="primary"
                />

                <ToolbarButton
                    icon={<Trash2 className="w-4 h-4" />}
                    label="Delete"
                    onClick={handleDelete}
                    disabled={!hasSelection}
                    variant="destructive"
                />

                <div className="w-px h-7 bg-black/[0.08] dark:bg-white/[0.06]" />

                {/* Connection type selector */}
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                        <button className="h-9 px-3 flex items-center gap-2 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.08] dark:border-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] text-xs font-medium text-ink transition-colors outline-none focus:ring-2 focus:ring-accent-lineage/40">
                            <Spline className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                            <span className="truncate max-w-[120px]">{activeLabel}</span>
                            <ChevronDown className="w-3 h-3 text-ink-muted" />
                        </button>
                    </DropdownMenu.Trigger>

                    <DropdownMenu.Portal>
                        <DropdownMenu.Content
                            className="min-w-[180px] bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] rounded-xl shadow-2xl shadow-black/30 p-1 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                            sideOffset={6}
                        >
                            <DropdownMenu.Item
                                className="flex items-center justify-between px-2.5 py-1.5 text-xs text-ink rounded-lg hover:bg-accent-lineage/10 cursor-pointer outline-none focus:bg-accent-lineage/10"
                                onSelect={() => onSelectEdgeType('manual')}
                            >
                                <span>Manual (Default)</span>
                                {activeEdgeType === 'manual' && <Check className="w-3 h-3 text-accent-lineage" />}
                            </DropdownMenu.Item>

                            {edgeTypes.length > 0 && <DropdownMenu.Separator className="h-px bg-black/[0.08] dark:bg-white/[0.06] my-1" />}

                            {edgeTypes.map(t => (
                                <DropdownMenu.Item
                                    key={t.id}
                                    className="flex flex-col items-start px-2.5 py-1.5 text-xs text-ink rounded-lg hover:bg-accent-lineage/10 cursor-pointer outline-none focus:bg-accent-lineage/10 gap-0.5"
                                    onSelect={() => onSelectEdgeType(t.id)}
                                >
                                    <div className="flex items-center justify-between w-full">
                                        <span className="font-medium">{t.name}</span>
                                        {activeEdgeType === t.id && <Check className="w-3 h-3 text-accent-lineage" />}
                                    </div>
                                    <span className="text-[10px] text-ink-muted">
                                        {t.sourceTypes?.join(', ') || '*'} → {t.targetTypes?.join(', ') || '*'}
                                    </span>
                                </DropdownMenu.Item>
                            ))}
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>

                <div className="w-px h-7 bg-black/[0.08] dark:bg-white/[0.06]" />

                <ToolbarButton
                    icon={<X className="w-4 h-4" />}
                    label="Done"
                    onClick={() => setEditing(false)}
                />
            </div>

            <div className="self-start px-3 py-1.5 rounded-lg bg-canvas-elevated/80 backdrop-blur border border-black/[0.06] dark:border-white/[0.06] text-2xs text-ink-muted">
                Drag from a node handle to draw a connection
            </div>
        </div>
    )
}

function ToolbarButton({
    icon,
    label,
    onClick,
    disabled = false,
    variant = 'default'
}: {
    icon: React.ReactNode
    label: string
    onClick: () => void
    disabled?: boolean
    variant?: 'default' | 'primary' | 'destructive'
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={label}
            className={cn(
                'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all duration-200',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                variant === 'default' && 'bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.08] dark:border-white/[0.08] text-ink hover:bg-black/[0.08] dark:hover:bg-white/[0.10]',
                variant === 'primary' && 'bg-gradient-to-r from-green-500/15 to-emerald-500/[0.08] text-green-700 border border-green-500/40 hover:from-green-500/25 hover:to-emerald-500/15 hover:border-green-500/60 dark:from-green-500/20 dark:to-emerald-500/10 dark:text-green-400 dark:border-green-500/30',
                variant === 'destructive' && 'bg-red-500/[0.06] text-red-600 border border-red-500/25 hover:bg-red-500/[0.12] hover:border-red-500/40 dark:text-red-400',
            )}
        >
            {icon}
            <span>{label}</span>
        </button>
    )
}
