import { useState, useMemo } from 'react'
import {
    Search,
    Box,
    GripVertical,
    Check
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/store/canvas'

// ============================================
// Types
// ============================================

interface SmartAssignmentPanelProps {
    className?: string
    assignedEntityIds: Set<string> // IDs of entities already manually assigned
}



// ============================================
// Main Component
// ============================================

export function SmartAssignmentPanel({
    className,
    assignedEntityIds
}: SmartAssignmentPanelProps) {
    const [searchQuery, setSearchQuery] = useState('')
    const [typeFilter, setTypeFilter] = useState<string>('all')

    // Get entities from canvas store (source of truth for now)
    // In a real scenario, this might fetch from a backend API
    const nodes = useCanvasStore(s => s.nodes)

    // Derived list of entities
    const filteredEntities = useMemo(() => {
        return nodes
            .filter(n => n.data.type !== 'ghost') // Exclude ghost nodes
            .map(n => ({
                id: n.id,
                name: n.data.label || n.data.businessLabel || n.id,
                type: n.data.type || 'unknown',
                urn: n.data.urn || n.id
            }))
            .filter(e => {
                const matchesSearch = e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    e.urn.toLowerCase().includes(searchQuery.toLowerCase())
                const matchesType = typeFilter === 'all' || e.type === typeFilter
                return matchesSearch && matchesType
            })
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [nodes, searchQuery, typeFilter])

    // Get unique types for filter
    const entityTypes = useMemo(() => {
        const types = new Set(nodes.map(n => n.data.type || 'unknown'))
        return Array.from(types).sort()
    }, [nodes])

    return (
        <div className={cn("flex flex-col h-full bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-800", className)}>
            {/* Header / Search */}
            <div className="p-4 space-y-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 rounded-t-xl">
                <div className="flex items-center gap-2 mb-1">
                    <Box className="w-5 h-5 text-blue-500" />
                    <h3 className="font-semibold text-slate-800 dark:text-white">Available Entities</h3>
                    <span className="ml-auto text-xs px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500">
                        {filteredEntities.length}
                    </span>
                </div>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                        type="text"
                        placeholder="Search by name or URN..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                    />
                </div>

                <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                    <button
                        onClick={() => setTypeFilter('all')}
                        className={cn(
                            "px-3 py-1 text-xs rounded-full whitespace-nowrap transition-colors",
                            typeFilter === 'all'
                                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium"
                                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 hover:bg-slate-200"
                        )}
                    >
                        All Types
                    </button>
                    {entityTypes.map(type => (
                        <button
                            key={type}
                            onClick={() => setTypeFilter(type)}
                            className={cn(
                                "px-3 py-1 text-xs rounded-full whitespace-nowrap transition-colors",
                                typeFilter === type
                                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium"
                                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 hover:bg-slate-200"
                            )}
                        >
                            {type}
                        </button>
                    ))}
                </div>
            </div>

            {/* Entity List */}
            <div className="flex-1 p-2 overflow-y-auto min-h-0">
                {filteredEntities.length > 0 ? (
                    <div className="space-y-1">
                        {filteredEntities.map((entity) => {
                            const isAssigned = assignedEntityIds.has(entity.id)

                            const handleDragStart = (e: React.DragEvent) => {
                                e.dataTransfer.setData('application/x-entity-assignment', JSON.stringify({
                                    entityId: entity.id,
                                    entityName: entity.name,
                                    entityType: entity.type
                                }))
                                e.dataTransfer.effectAllowed = 'copy'
                            }

                            return (
                                <div
                                    key={entity.id}
                                    draggable
                                    onDragStart={handleDragStart}
                                    className={cn(
                                        "flex items-center gap-3 p-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing hover:shadow-md",
                                        isAssigned
                                            ? "bg-blue-50/50 border-blue-100 dark:bg-blue-900/10 dark:border-blue-900/30"
                                            : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600"
                                    )}
                                >
                                    <GripVertical className="w-4 h-4 text-slate-300" />

                                    <div className={cn(
                                        "w-8 h-8 rounded flex items-center justify-center text-xs font-bold uppercase",
                                        "bg-slate-100 dark:bg-slate-700 text-slate-500"
                                    )}>
                                        {entity.type.slice(0, 2)}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                                            {entity.name}
                                        </p>
                                        <p className="text-xs text-slate-400 truncate">
                                            {entity.urn}
                                        </p>
                                    </div>

                                    {isAssigned && (
                                        <div className="text-blue-500" title="Assigned">
                                            <Check className="w-4 h-4" />
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-4">
                        <Search className="w-8 h-8 mb-2 opacity-50" />
                        <p className="text-sm">No entities found</p>
                        <p className="text-xs">Try adjusting your filters</p>
                    </div>
                )}
            </div>
        </div>
    )
}
