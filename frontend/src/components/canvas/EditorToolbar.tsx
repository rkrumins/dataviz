import { Plus, Trash2, Save, X, ChevronDown, Check } from 'lucide-react'
import { useCanvasStore } from '@/store/canvas'
import { cn } from '@/lib/utils'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

export interface EditorToolbarProps {
    onAddNode: () => void
    onSave?: () => void
    onDelete?: () => void
    edgeTypes: any[] // RelationshipTypeSchema[]
    activeEdgeType: string
    onSelectEdgeType: (typeId: string) => void
}

export function EditorToolbar({
    onAddNode,
    onSave,
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

    const handleSave = () => {
        // Placeholder for save logic
        console.log('Saving graph layout...')
        setEditing(false)
    }

    const handleCancel = () => {
        setEditing(false)
    }

    // Get active type label and rules
    const activeType = edgeTypes.find(t => t.id === activeEdgeType)
    const activeLabel = activeType?.name || 'Manual (Default)'

    // Format rules for display
    const getRuleText = () => {
        if (!activeType || activeEdgeType === 'manual') return 'Connect any nodes'

        const sources = activeType.sourceTypes?.join(', ') || 'Any'
        const targets = activeType.targetTypes?.join(', ') || 'Any'
        return `${sources} → ${targets}`
    }

    if (!isEditing) return null

    return (
        <div className="flex flex-col gap-2">
            <div className="glass-panel p-2 rounded-xl flex items-center gap-2 shadow-lg">
                <div className="flex items-center gap-1 border-r border-glass-border pr-2 mr-2">
                    <span className="text-xs font-semibold px-2 text-accent-lineage">
                        EDIT MODE
                    </span>
                </div>

                <div className="flex flex-col justify-center mr-2 px-2 border-r border-glass-border min-w-[120px]">
                    <span className="text-[10px] font-medium text-ink-muted uppercase tracking-wider">Rules</span>
                    <span className="text-xs text-accent-lineage truncate max-w-[150px]" title={getRuleText()}>
                        {getRuleText()}
                    </span>
                </div>

                <ToolbarButton
                    icon={<Plus className="w-4 h-4" />}
                    label="Add Node"
                    onClick={onAddNode}
                />

                <ToolbarButton
                    icon={<Trash2 className="w-4 h-4" />}
                    label="Delete"
                    onClick={handleDelete}
                    disabled={selectedNodeIds.length === 0 && selectedEdgeIds.length === 0}
                    variant="destructive"
                />

                <div className="w-px h-6 bg-glass-border mx-1" />

                {/* Edge Type Selector */}
                <div className="flex flex-col gap-1 mx-1">
                    <span className="text-[10px] font-medium text-ink-muted uppercase tracking-wider px-1">Connection</span>

                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                            <button className="h-7 px-2 flex items-center gap-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-md text-xs font-medium text-ink transition-colors outline-none focus:ring-2 focus:ring-accent-lineage/50">
                                <span className="truncate max-w-[120px]">{activeLabel}</span>
                                <ChevronDown className="w-3 h-3 text-ink-muted" />
                            </button>
                        </DropdownMenu.Trigger>

                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                className="min-w-[160px] bg-canvas-elevated border border-glass-border rounded-lg shadow-xl p-1 z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                                sideOffset={5}
                            >
                                <DropdownMenu.Item
                                    className="flex items-center justify-between px-2 py-1.5 text-xs text-ink rounded-md hover:bg-accent-lineage/10 cursor-pointer outline-none focus:bg-accent-lineage/10"
                                    onSelect={() => onSelectEdgeType('manual')}
                                >
                                    <span>Manual (Default)</span>
                                    {activeEdgeType === 'manual' && <Check className="w-3 h-3 text-accent-lineage" />}
                                </DropdownMenu.Item>

                                {edgeTypes.length > 0 && <DropdownMenu.Separator className="h-px bg-glass-border my-1" />}

                                {edgeTypes.map(t => (
                                    <DropdownMenu.Item
                                        key={t.id}
                                        className="flex flex-col items-start px-2 py-1.5 text-xs text-ink rounded-md hover:bg-accent-lineage/10 cursor-pointer outline-none focus:bg-accent-lineage/10 gap-0.5"
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
                </div>

                <div className="w-px h-6 bg-glass-border mx-1" />

                <ToolbarButton
                    icon={<Save className="w-4 h-4" />}
                    label="Save Graph"
                    onClick={onSave || handleSave}
                    variant="primary"
                />

                <ToolbarButton
                    icon={<X className="w-4 h-4" />}
                    label="Exit"
                    onClick={handleCancel}
                />
            </div>

            <div className="glass-panel-subtle px-3 py-1.5 rounded-lg text-2xs text-ink-muted text-center animate-in fade-in slide-in-from-top-2">
                Drag from handles to connect nodes
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
            className={cn(
                "flex flex-col items-center gap-1 p-2 rounded-lg min-w-[60px] transition-all",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                variant === 'default' && "hover:bg-black/5 dark:hover:bg-white/5 text-ink",
                variant === 'primary' && "bg-accent-lineage text-white hover:bg-accent-lineage-hover shadow-sm",
                variant === 'destructive' && "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            )}
            title={label}
        >
            {icon}
            <span className="text-[10px] font-medium">{label}</span>
        </button>
    )
}
