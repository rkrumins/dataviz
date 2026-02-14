import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { Edit2, X, Save, Check } from 'lucide-react'

export function EditNodePanel() {
    const { selectedNodeIds, nodes, updateNode, isEditing, setEditing } = useCanvasStore()
    const { schema } = useSchemaStore()

    // Only show if editing mode is active AND exactly one node is selected
    const isVisible = isEditing && selectedNodeIds.length === 1
    const selectedNode = isVisible ? nodes.find(n => n.id === selectedNodeIds[0]) : null

    // Local form state
    const [formData, setFormData] = useState<Record<string, any>>({})
    const [hasChanges, setHasChanges] = useState(false)
    const [showSaved, setShowSaved] = useState(false)

    // Reset form when selection changes
    useEffect(() => {
        if (selectedNode) {
            const data = selectedNode.data as Record<string, any>
            setFormData({
                label: data.label || data.name || '',
                description: data.description || '',
                ...data
            })
            setHasChanges(false)
        }
    }, [selectedNode?.id])

    if (!isVisible || !selectedNode) return null

    const entityType = schema?.entityTypes.find(t => t.id === selectedNode.data.type)

    const handleSave = () => {
        updateNode(selectedNode.id, formData)
        setHasChanges(false)
        setShowSaved(true)
        setTimeout(() => setShowSaved(false), 2000)
    }

    const handleChange = (key: string, value: string) => {
        setFormData(prev => ({ ...prev, [key]: value }))
        setHasChanges(true)
        // Real-time update for label for better UX
        if (key === 'label') {
            updateNode(selectedNode.id, { label: value })
        }
    }

    const handleClose = () => {
        useCanvasStore.getState().clearSelection()
        setEditing(false)
    }

    return (
        <div className="absolute top-20 right-4 w-96 max-h-[calc(100vh-120px)] bg-canvas-elevated border border-glass-border rounded-xl shadow-2xl overflow-hidden flex flex-col z-20 animate-in slide-in-from-right-10 fade-in duration-200">
            {/* Header - Sticky */}
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-glass-border bg-canvas-elevated">
                <div className="flex items-center gap-2">
                    <Edit2 className="w-4 h-4 text-accent-lineage" />
                    <span className="text-sm font-medium text-ink">Edit Node</span>
                    {hasChanges && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded">
                            Unsaved
                        </span>
                    )}
                    {showSaved && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-600 dark:text-green-400 rounded flex items-center gap-1">
                            <Check className="w-3 h-3" />
                            Saved
                        </span>
                    )}
                </div>
                <button
                    onClick={handleClose}
                    className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Form Fields - Scrollable content area */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 custom-scrollbar">

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

                {/* Custom JSON Data (Advanced) - Collapsible */}
                <details className="pt-4 border-t border-glass-border group">
                    <summary className="text-xs font-medium text-ink-muted cursor-pointer hover:text-ink transition-colors flex items-center gap-1">
                        <span className="group-open:rotate-90 transition-transform">▶</span>
                        Raw Data (Advanced)
                    </summary>
                    <pre className="mt-2 text-[10px] bg-black/5 dark:bg-white/5 rounded-lg p-3 overflow-x-auto max-h-[200px] overflow-y-auto custom-scrollbar">
                        {JSON.stringify(selectedNode.data, null, 2)}
                    </pre>
                </details>
            </div>

            {/* Footer - Sticky at bottom */}
            <div className="flex-shrink-0 p-4 border-t border-glass-border flex items-center justify-between gap-2 bg-canvas-elevated">
                <span className="text-xs text-ink-muted">
                    {entityType?.name || selectedNode.data.type}
                </span>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleClose}
                        className="px-3 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!hasChanges}
                        className="px-4 py-2 bg-accent-lineage text-white rounded-lg text-sm font-medium hover:bg-accent-lineage/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                        <Save className="w-4 h-4" />
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    )
}
