import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { Edit2, X } from 'lucide-react'

export function EditNodePanel() {
    const { selectedNodeIds, nodes, updateNode, isEditing } = useCanvasStore()
    const { schema } = useSchemaStore()

    // Only show if editing mode is active AND exactly one node is selected
    const isVisible = isEditing && selectedNodeIds.length === 1
    const selectedNode = isVisible ? nodes.find(n => n.id === selectedNodeIds[0]) : null

    // Local form state
    const [formData, setFormData] = useState<Record<string, any>>({})

    // Reset form when selection changes
    useEffect(() => {
        if (selectedNode) {
            const data = selectedNode.data as Record<string, any>
            setFormData({
                label: data.label || data.name || '',
                description: data.description || '',
                ...data
            })
        }
    }, [selectedNode?.id])

    if (!isVisible || !selectedNode) return null

    const entityType = schema?.entityTypes.find(t => t.id === selectedNode.data.type)

    const handleSave = () => {
        updateNode(selectedNode.id, formData)
    }

    const handleChange = (key: string, value: string) => {
        setFormData(prev => ({ ...prev, [key]: value }))
        // Real-time update for better UX? Or explicit save?
        // Let's do real-time for name, but maybe keep others robust
        if (key === 'label') {
            updateNode(selectedNode.id, { label: value })
        }
    }

    return (
        <div className="absolute top-20 right-4 w-80 bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden flex flex-col z-20 animate-in slide-in-from-right-10 fade-in duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border bg-black/5 dark:bg-white/5">
                <div className="flex items-center gap-2">
                    <Edit2 className="w-4 h-4 text-accent-lineage" />
                    <span className="text-sm font-medium text-ink">Edit Node</span>
                </div>
                <button
                    onClick={() => useCanvasStore.getState().clearSelection()}
                    className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Form Fields */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">

                {/* Name / Label */}
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-muted">Name</label>
                    <input
                        type="text"
                        value={formData.label || ''}
                        onChange={(e) => handleChange('label', e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-transparent focus:border-accent-lineage focus:bg-white dark:focus:bg-black transition-all outline-none text-sm"
                    />
                </div>

                {/* Dynamic Fields from Schema */}
                {entityType?.fields.filter(f => !['name', 'label'].includes(f.id)).map(field => (
                    <div key={field.id} className="space-y-1.5">
                        <label className="text-xs font-medium text-ink-muted">{field.name}</label>
                        {/* Cast to string to safely check type options that might not exist on the narrow type */}
                        {(field.type as string) === 'markdown' || (field.type as string) === 'textarea' ? (
                            <textarea
                                value={formData[field.id] || ''}
                                onChange={(e) => handleChange(field.id, e.target.value)}
                                rows={3}
                                className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-transparent focus:border-accent-lineage focus:bg-white dark:focus:bg-black transition-all outline-none text-sm"
                            />
                        ) : (
                            <input
                                type="text"
                                value={formData[field.id] || ''}
                                onChange={(e) => handleChange(field.id, e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-transparent focus:border-accent-lineage focus:bg-white dark:focus:bg-black transition-all outline-none text-sm"
                            />
                        )}
                    </div>
                ))}

                {/* Custom JSON Data (Advanced) */}
                <div className="pt-4 border-t border-glass-border">
                    <label className="text-xs font-medium text-ink-muted block mb-2">Raw Data</label>
                    <pre className="text-[10px] bg-black/5 rounded p-2 overflow-x-auto">
                        {JSON.stringify(selectedNode.data, null, 2)}
                    </pre>
                </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-glass-border flex justify-end gap-2 bg-glass-background/50">
                <button
                    onClick={handleSave}
                    className="px-4 py-2 bg-accent-lineage text-white rounded-lg text-sm font-medium hover:bg-accent-lineage-hover transition-colors shadow-sm"
                >
                    Update Node
                </button>
            </div>
        </div>
    )
}
