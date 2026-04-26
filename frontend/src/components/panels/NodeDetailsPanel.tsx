/**
 * NodeDetailsPanel - Unified panel for viewing and editing node details
 * 
 * This panel consolidates the previous separate "view" and "edit" modes into
 * a single component that:
 * - Shows automatically when a node is selected
 * - Displays node properties in read-only mode by default
 * - Has an "Edit" toggle to enable inline editing
 * - Supports raw JSON editing for advanced users
 * - Works consistently across all canvas views
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

// Dynamic icon component
function DynamicIcon({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const IconComponent = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>>)[name]
  if (!IconComponent) {
    return <LucideIcons.Box className={className} style={style} />
  }
  return <IconComponent className={className} style={style} />
}

interface NodeDetailsPanelProps {
  className?: string
  onClose?: () => void
}

export function NodeDetailsPanel({ className, onClose }: NodeDetailsPanelProps) {
  const { selectedNodeIds, nodes, updateNode, clearSelection } = useCanvasStore()
  const { schema } = useSchemaStore()

  // Only show if exactly one node is selected
  const selectedNode = selectedNodeIds.length === 1 
    ? nodes.find(n => n.id === selectedNodeIds[0]) 
    : null

  // Local state
  const [isEditMode, setIsEditMode] = useState(false)
  const [isRawMode, setIsRawMode] = useState(false)
  const [formData, setFormData] = useState<Record<string, any>>({})
  const [rawJson, setRawJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const [activeTab, setActiveTab] = useState<'properties' | 'metadata' | 'lineage'>('properties')

  // Reset state when selection changes
  useEffect(() => {
    if (selectedNode) {
      const data = selectedNode.data as Record<string, any>
      setFormData({
        label: data.label || data.name || '',
        description: data.description || '',
        ...data
      })
      setRawJson(JSON.stringify(data, null, 2))
      setHasChanges(false)
      setJsonError(null)
      setIsEditMode(false)
      setIsRawMode(false)
      setActiveTab('properties')
    }
  }, [selectedNode?.id])

  // Get entity type info from schema
  const entityType = useMemo(() => {
    if (!selectedNode || !schema) return null
    return schema.entityTypes.find(t => t.id === selectedNode.data.type)
  }, [selectedNode, schema])

  const visual = entityType?.visual
  const nodeColor = visual?.color ?? '#6366f1'

  // Handle form field changes
  const handleChange = useCallback((key: string, value: any) => {
    const newData = { ...formData, [key]: value }
    setFormData(newData)
    setRawJson(JSON.stringify(newData, null, 2))
    setHasChanges(true)
    setJsonError(null)
  }, [formData])

  // Handle raw JSON changes
  const handleRawJsonChange = useCallback((value: string) => {
    setRawJson(value)
    setHasChanges(true)
    try {
      const parsed = JSON.parse(value)
      setFormData(parsed)
      setJsonError(null)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }, [])

  // Save changes
  const handleSave = useCallback(() => {
    if (!selectedNode) return
    if (jsonError) {
      alert('Please fix JSON errors before saving')
      return
    }
    updateNode(selectedNode.id, formData)
    setHasChanges(false)
    setShowSaved(true)
    setTimeout(() => setShowSaved(false), 2000)
    setRawJson(JSON.stringify(formData, null, 2))
  }, [selectedNode, formData, jsonError, updateNode])

  // Cancel changes
  const handleCancel = useCallback(() => {
    if (selectedNode) {
      const data = selectedNode.data as Record<string, any>
      setFormData({
        label: data.label || data.name || '',
        description: data.description || '',
        ...data
      })
      setRawJson(JSON.stringify(data, null, 2))
      setHasChanges(false)
      setJsonError(null)
    }
    setIsEditMode(false)
    setIsRawMode(false)
  }, [selectedNode])

  // Close panel
  const handleClose = useCallback(() => {
    clearSelection()
    onClose?.()
  }, [clearSelection, onClose])

  // Don't render if no node selected
  if (!selectedNode) return null

  // Get additional metadata for display
  const urn = formData.urn || selectedNode.id
  const type = formData.type || selectedNode.data.type
  const childCount = formData.childCount || formData._collapsedChildCount || 0

  // Define which fields are "core" vs "additional"
  const coreFields = ['label', 'name', 'description', 'urn', 'type']
  const additionalFields = Object.keys(formData).filter(
    k => !coreFields.includes(k) && !k.startsWith('_') && k !== 'childCount'
  )

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className={cn(
        "absolute top-4 right-4 w-[420px] max-h-[calc(100vh-100px)] bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-2xl shadow-lg overflow-hidden flex flex-col z-30",
        className
      )}
    >
      {/* Header */}
      <div 
        className="flex-shrink-0 px-5 py-4 border-b border-glass-border/50"
        style={{ 
          background: `linear-gradient(135deg, ${nodeColor}15 0%, transparent 100%)`
        }}
      >
        <div className="flex items-start gap-3">
          {/* Entity Icon */}
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg"
            style={{ 
              background: `linear-gradient(145deg, ${nodeColor}30 0%, ${nodeColor}15 100%)`,
              boxShadow: `0 4px 12px ${nodeColor}25`
            }}
          >
            <DynamicIcon
              name={visual?.icon ?? 'Box'}
              className="w-6 h-6"
              style={{ color: nodeColor }}
            />
          </div>

          {/* Title & Type */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-ink truncate">
                {formData.label || formData.name || selectedNode.id}
              </h3>
              {hasChanges && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-md flex-shrink-0">
                  Unsaved
                </span>
              )}
              {showSaved && (
                <motion.span 
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="px-1.5 py-0.5 text-[10px] font-semibold bg-green-500/20 text-green-600 dark:text-green-400 rounded-md flex items-center gap-1 flex-shrink-0"
                >
                  <LucideIcons.Check className="w-3 h-3" />
                  Saved
                </motion.span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span 
                className="px-2 py-0.5 rounded-md text-xs font-medium"
                style={{ backgroundColor: `${nodeColor}20`, color: nodeColor }}
              >
                {entityType?.name ?? type}
              </span>
              {childCount > 0 && (
                <span className="text-xs text-ink-muted">
                  {childCount} children
                </span>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Edit Toggle */}
            <button
              onClick={() => setIsEditMode(!isEditMode)}
              className={cn(
                "p-2 rounded-lg transition-colors duration-150 duration-200",
                isEditMode 
                  ? "bg-accent-lineage/20 text-accent-lineage shadow-lg shadow-accent-lineage/20" 
                  : "hover:bg-white/[0.08] text-ink-muted hover:text-ink"
              )}
              title={isEditMode ? 'Exit Edit Mode' : 'Edit Properties'}
            >
              <LucideIcons.Pencil className="w-4 h-4" />
            </button>

            {/* Raw JSON Toggle (only in edit mode) */}
            {isEditMode && (
              <button
                onClick={() => setIsRawMode(!isRawMode)}
                className={cn(
                  "p-2 rounded-lg transition-colors duration-150 duration-200",
                  isRawMode 
                    ? "bg-purple-500/20 text-purple-500" 
                    : "hover:bg-white/[0.08] text-ink-muted hover:text-ink"
                )}
                title={isRawMode ? 'Switch to Form View' : 'Edit Raw JSON'}
              >
                <LucideIcons.Code className="w-4 h-4" />
              </button>
            )}

            {/* Close */}
            <button
              onClick={handleClose}
              className="p-2 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-colors duration-150"
            >
              <LucideIcons.X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* JSON Error Banner */}
        <AnimatePresence>
          {jsonError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2"
            >
              <LucideIcons.AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">JSON Error: {jsonError}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Tab Navigation (for read mode) */}
      {!isEditMode && !isRawMode && (
        <div className="flex-shrink-0 flex items-center gap-1 px-4 py-2 border-b border-glass-border/30 bg-white/[0.02]">
          {(['properties', 'metadata', 'lineage'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150 duration-200 capitalize",
                activeTab === tab
                  ? "bg-white/[0.08] text-ink"
                  : "text-ink-muted hover:text-ink hover:bg-white/[0.04]"
              )}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {isRawMode ? (
          /* Raw JSON Editor */
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-ink-muted">Edit Raw JSON</label>
              <span className={cn(
                "text-[10px] px-2 py-0.5 rounded-full",
                jsonError ? "bg-red-500/10 text-red-500" : "bg-green-500/10 text-green-500"
              )}>
                {jsonError ? '⚠️ Invalid JSON' : '✓ Valid JSON'}
              </span>
            </div>
            <textarea
              value={rawJson}
              onChange={(e) => handleRawJsonChange(e.target.value)}
              className={cn(
                "w-full h-[400px] px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border transition-colors duration-150 outline-none text-xs font-mono resize-none custom-scrollbar",
                jsonError 
                  ? "border-red-500/30 focus:border-red-500/50" 
                  : "border-white/[0.08] focus:border-accent-lineage/40"
              )}
              spellCheck={false}
            />
          </div>
        ) : isEditMode ? (
          /* Edit Mode Form */
          <div className="p-4 space-y-4">
            {/* Core Fields */}
            <div className="space-y-3">
              {/* Name/Label */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-muted flex items-center gap-1">
                  <LucideIcons.Type className="w-3 h-3" />
                  Name
                </label>
                <input
                  type="text"
                  value={formData.label || ''}
                  onChange={(e) => handleChange('label', e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] focus:border-accent-lineage/40 focus:bg-white/[0.06] transition-colors duration-150 outline-none text-sm"
                  placeholder="Entity name..."
                />
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-muted flex items-center gap-1">
                  <LucideIcons.FileText className="w-3 h-3" />
                  Description
                </label>
                <textarea
                  value={formData.description || ''}
                  onChange={(e) => handleChange('description', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] focus:border-accent-lineage/40 focus:bg-white/[0.06] transition-colors duration-150 outline-none text-sm resize-none"
                  placeholder="Add a description..."
                />
              </div>

              {/* URN (read-only) */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-muted flex items-center gap-1">
                  <LucideIcons.Link className="w-3 h-3" />
                  URN
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={urn}
                    readOnly
                    className="flex-1 px-3 py-2.5 rounded-xl bg-black/[0.06] dark:bg-white/[0.06] border border-transparent text-ink-muted text-sm cursor-not-allowed font-mono text-xs"
                  />
                  <button
                    onClick={() => navigator.clipboard.writeText(urn)}
                    className="p-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-colors duration-150"
                    title="Copy URN"
                  >
                    <LucideIcons.Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Dynamic Fields from Schema */}
            {entityType?.fields && entityType.fields.filter(f => !coreFields.includes(f.id)).length > 0 && (
              <div className="pt-4 border-t border-glass-border/30">
                <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                  Additional Properties
                </h4>
                <div className="space-y-3">
                  {entityType.fields.filter(f => !coreFields.includes(f.id)).map(field => (
                    <div key={field.id} className="space-y-1.5">
                      <label className="text-xs font-medium text-ink-muted">{field.name}</label>
                      {(field.type as string) === 'markdown' || (field.type as string) === 'textarea' ? (
                        <textarea
                          value={formData[field.id] || ''}
                          onChange={(e) => handleChange(field.id, e.target.value)}
                          rows={2}
                          className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] focus:border-accent-lineage/40 transition-colors duration-150 outline-none text-sm resize-none"
                        />
                      ) : (
                        <input
                          type="text"
                          value={formData[field.id] || ''}
                          onChange={(e) => handleChange(field.id, e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] focus:border-accent-lineage/40 transition-colors duration-150 outline-none text-sm"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Other Properties */}
            {additionalFields.length > 0 && (
              <div className="pt-4 border-t border-glass-border/30">
                <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                  Custom Properties
                </h4>
                <div className="space-y-3">
                  {additionalFields.slice(0, 10).map(key => (
                    <div key={key} className="space-y-1.5">
                      <label className="text-xs font-medium text-ink-muted capitalize">
                        {key.replace(/([A-Z])/g, ' $1').trim()}
                      </label>
                      <input
                        type="text"
                        value={typeof formData[key] === 'object' ? JSON.stringify(formData[key]) : formData[key] || ''}
                        onChange={(e) => handleChange(key, e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] focus:border-accent-lineage/40 transition-colors duration-150 outline-none text-sm"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick JSON Access */}
            <button
              onClick={() => setIsRawMode(true)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 mt-4 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-ink-muted hover:text-ink text-xs font-medium transition-colors duration-150"
            >
              <LucideIcons.Code className="w-4 h-4" />
              Edit as Raw JSON
            </button>
          </div>
        ) : (
          /* Read Mode - Properties Tab */
          <div className="p-4">
            {activeTab === 'properties' && (
              <div className="space-y-4">
                {/* Core Info */}
                <div className="space-y-3">
                  {/* Description */}
                  {formData.description && (
                    <div>
                      <p className="text-sm text-ink leading-relaxed">{formData.description}</p>
                    </div>
                  )}

                  {/* URN */}
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                    <LucideIcons.Link className="w-4 h-4 text-ink-muted flex-shrink-0" />
                    <code className="flex-1 text-xs font-mono text-ink-muted truncate">{urn}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(urn)}
                      className="p-1.5 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-colors duration-150"
                      title="Copy URN"
                    >
                      <LucideIcons.Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Properties Grid */}
                {additionalFields.length > 0 && (
                  <div className="pt-4 border-t border-glass-border/30">
                    <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                      Properties
                    </h4>
                    <div className="space-y-2">
                      {additionalFields.slice(0, 15).map(key => {
                        const value = formData[key]
                        const displayValue = typeof value === 'object' 
                          ? JSON.stringify(value) 
                          : String(value || '—')
                        
                        return (
                          <div key={key} className="flex items-start gap-3 py-2 border-b border-glass-border/20 last:border-0">
                            <span className="text-xs font-medium text-ink-muted min-w-[100px] capitalize">
                              {key.replace(/([A-Z])/g, ' $1').trim()}
                            </span>
                            <span className="text-xs text-ink flex-1 break-all">
                              {displayValue.length > 100 ? displayValue.slice(0, 100) + '...' : displayValue}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Classifications/Tags */}
                {formData.classifications && Array.isArray(formData.classifications) && formData.classifications.length > 0 && (
                  <div className="pt-4 border-t border-glass-border/30">
                    <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
                      Classifications
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {(formData.classifications as string[]).map(tag => (
                        <span
                          key={tag}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium"
                          style={{ backgroundColor: `${nodeColor}15`, color: nodeColor }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {!formData.description && additionalFields.length === 0 && (
                  <div className="py-8 text-center">
                    <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
                      <LucideIcons.FileQuestion className="w-6 h-6 text-ink-muted/40" />
                    </div>
                    <p className="text-sm text-ink-muted">No additional properties</p>
                    <button
                      onClick={() => setIsEditMode(true)}
                      className="mt-3 text-xs text-accent-lineage hover:underline"
                    >
                      Add properties →
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'metadata' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between py-2 border-b border-glass-border/20">
                    <span className="text-xs font-medium text-ink-muted">Type</span>
                    <span className="text-xs text-ink">{entityType?.name ?? type}</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-glass-border/20">
                    <span className="text-xs font-medium text-ink-muted">ID</span>
                    <code className="text-xs text-ink font-mono">{selectedNode.id}</code>
                  </div>
                  {childCount > 0 && (
                    <div className="flex items-center justify-between py-2 border-b border-glass-border/20">
                      <span className="text-xs font-medium text-ink-muted">Children</span>
                      <span className="text-xs text-ink">{childCount}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between py-2">
                    <span className="text-xs font-medium text-ink-muted">Position</span>
                    <code className="text-xs text-ink-muted font-mono">
                      ({Math.round(selectedNode.position.x)}, {Math.round(selectedNode.position.y)})
                    </code>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'lineage' && (
              <div className="py-8 text-center">
                <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
                  <LucideIcons.GitBranch className="w-6 h-6 text-ink-muted/40" />
                </div>
                <p className="text-sm text-ink-muted">Lineage information</p>
                <p className="text-xs text-ink-muted/60 mt-1">Double-click to trace this entity</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer - Save/Cancel buttons (only in edit mode) */}
      <AnimatePresence>
        {isEditMode && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex-shrink-0 px-4 py-3 border-t border-glass-border/50 bg-canvas-elevated/50 flex items-center justify-between gap-3"
          >
            <span className="text-xs text-ink-muted">
              {hasChanges ? 'You have unsaved changes' : 'Edit mode active'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/[0.06] rounded-xl transition-colors duration-150"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || !!jsonError}
                className={cn(
                  "px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-colors duration-150",
                  hasChanges && !jsonError
                    ? "bg-accent-lineage text-white hover:bg-accent-lineage/90 shadow-lg shadow-accent-lineage/25"
                    : "bg-white/[0.06] text-ink-muted cursor-not-allowed"
                )}
              >
                <LucideIcons.Save className="w-4 h-4" />
                Save Changes
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default NodeDetailsPanel

