/**
 * ViewEditor - Component for editing view configurations
 * 
 * Allows users to configure:
 * - Visible entity types
 * - Visible relationship types
 * - Projection settings (aggregation, collapse)
 * - Reference model layers
 * - Layout options
 */

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import type { ViewConfiguration, EntityTypeSchema, ViewLayerConfig } from '@/types/schema'
import { cn } from '@/lib/utils'

// Dynamic icon component
function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComponent = (LucideIcons as Record<string, React.ComponentType<{ className?: string }>>)[name]
  if (!IconComponent) return <LucideIcons.Box className={className} />
  return <IconComponent className={className} />
}

interface ViewEditorProps {
  viewId?: string // Existing view ID to edit, or undefined for new
  onClose: () => void
  onSave: (view: ViewConfiguration) => void
}

const GRANULARITY_LEVELS = [
  { value: 0, label: 'Column', description: 'Most detailed - show all columns' },
  { value: 1, label: 'Table', description: 'Aggregate to table level' },
  { value: 2, label: 'Schema', description: 'Aggregate to schema level' },
  { value: 3, label: 'System', description: 'Aggregate to system level' },
  { value: 4, label: 'Domain', description: 'Most abstract - domains only' },
]

const LAYOUT_TYPES = [
  { value: 'graph', label: 'Graph', icon: 'Network', description: 'Force-directed or DAG layout' },
  { value: 'hierarchy', label: 'Hierarchy', icon: 'ListTree', description: 'Nested tree view' },
  { value: 'reference', label: 'Reference Model', icon: 'LayoutTemplate', description: 'Horizontal layer columns' },
]

export function ViewEditor({ viewId, onClose, onSave }: ViewEditorProps) {
  const schema = useSchemaStore((s) => s.schema)
  const getActiveView = useSchemaStore((s) => s.getActiveView)
  
  // Load existing view or create new one
  const existingView = viewId 
    ? schema?.views.find((v) => v.id === viewId)
    : undefined
  
  const [view, setView] = useState<Partial<ViewConfiguration>>(() => {
    if (existingView) return { ...existingView }
    return {
      id: `view-${Date.now()}`,
      name: 'New View',
      description: '',
      icon: 'Layout',
      content: {
        visibleEntityTypes: schema?.entityTypes.map((e) => e.id) ?? [],
        visibleRelationshipTypes: schema?.relationshipTypes.map((r) => r.id) ?? [],
        defaultDepth: 5,
        maxDepth: 10,
        rootEntityTypes: ['domain'],
      },
      layout: {
        type: 'graph',
        graphLayout: {
          algorithm: 'dagre',
          direction: 'LR',
          nodeSpacing: 60,
          levelSpacing: 120,
        },
        lod: { enabled: false, levels: [] },
        projection: {
          targetGranularity: 1,
          aggregateLineage: false,
          collapseChildren: false,
          containerTypes: [],
        },
        referenceLayout: {
          layers: [],
        },
      },
      filters: {
        entityTypeFilters: [],
        fieldFilters: [],
        searchableFields: [],
        quickFilters: [],
      },
      entityOverrides: {},
      isDefault: false,
      isPublic: true,
      createdBy: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })
  
  const [activeTab, setActiveTab] = useState<'general' | 'entities' | 'projection' | 'layers'>('general')
  
  // Update a nested property
  const updateView = <K extends keyof ViewConfiguration>(
    key: K, 
    value: ViewConfiguration[K]
  ) => {
    setView((prev) => ({ ...prev, [key]: value }))
  }
  
  const updateProjection = (key: string, value: unknown) => {
    setView((prev) => ({
      ...prev,
      layout: {
        ...prev.layout!,
        projection: {
          ...prev.layout?.projection,
          [key]: value,
        },
      },
    }))
  }
  
  const updateContent = (key: string, value: unknown) => {
    setView((prev) => ({
      ...prev,
      content: {
        ...prev.content!,
        [key]: value,
      },
    }))
  }
  
  // Toggle entity type visibility
  const toggleEntityType = (typeId: string) => {
    const current = view.content?.visibleEntityTypes ?? []
    const updated = current.includes(typeId)
      ? current.filter((id) => id !== typeId)
      : [...current, typeId]
    updateContent('visibleEntityTypes', updated)
  }
  
  // Add a layer
  const addLayer = () => {
    const layers = view.layout?.referenceLayout?.layers ?? []
    const newLayer: ViewLayerConfig = {
      id: `layer-${Date.now()}`,
      name: `Layer ${layers.length + 1}`,
      description: '',
      icon: 'Layers',
      color: '#6366f1',
      entityTypes: [],
      order: layers.length,
    }
    setView((prev) => ({
      ...prev,
      layout: {
        ...prev.layout!,
        referenceLayout: {
          layers: [...layers, newLayer],
        },
      },
    }))
  }
  
  const updateLayer = (layerId: string, updates: Partial<ViewLayerConfig>) => {
    const layers = view.layout?.referenceLayout?.layers ?? []
    const updated = layers.map((l) => 
      l.id === layerId ? { ...l, ...updates } : l
    )
    setView((prev) => ({
      ...prev,
      layout: {
        ...prev.layout!,
        referenceLayout: { layers: updated },
      },
    }))
  }
  
  const removeLayer = (layerId: string) => {
    const layers = view.layout?.referenceLayout?.layers ?? []
    setView((prev) => ({
      ...prev,
      layout: {
        ...prev.layout!,
        referenceLayout: {
          layers: layers.filter((l) => l.id !== layerId),
        },
      },
    }))
  }
  
  const handleSave = () => {
    const finalView: ViewConfiguration = {
      ...view,
      updatedAt: new Date().toISOString(),
    } as ViewConfiguration
    onSave(finalView)
  }
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative w-full max-w-3xl max-h-[85vh] glass-panel rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border">
          <div>
            <h2 className="text-lg font-display font-semibold text-ink">
              {existingView ? 'Edit View' : 'Create New View'}
            </h2>
            <p className="text-sm text-ink-muted">Configure how data is displayed</p>
          </div>
          <button onClick={onClose} className="btn btn-ghost p-2">
            <LucideIcons.X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Tabs */}
        <div className="flex border-b border-glass-border px-6">
          {[
            { id: 'general', label: 'General', icon: 'Settings' },
            { id: 'entities', label: 'Entities', icon: 'Grid3x3' },
            { id: 'projection', label: 'Projection', icon: 'Layers' },
            { id: 'layers', label: 'Layers', icon: 'LayoutTemplate' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={cn(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors",
                activeTab === tab.id
                  ? "border-accent-lineage text-accent-lineage"
                  : "border-transparent text-ink-muted hover:text-ink"
              )}
            >
              <DynamicIcon name={tab.icon} className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
        
        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <AnimatePresence mode="wait">
            {activeTab === 'general' && (
              <motion.div
                key="general"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-6"
              >
                {/* Name & Description */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5">View Name</label>
                    <input
                      type="text"
                      value={view.name ?? ''}
                      onChange={(e) => updateView('name', e.target.value)}
                      className="input"
                      placeholder="e.g., Data Lineage, Impact Analysis"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5">Description</label>
                    <textarea
                      value={view.description ?? ''}
                      onChange={(e) => updateView('description', e.target.value)}
                      className="input min-h-[80px]"
                      placeholder="Describe what this view shows..."
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5">Icon</label>
                    <input
                      type="text"
                      value={view.icon ?? ''}
                      onChange={(e) => updateView('icon', e.target.value)}
                      className="input"
                      placeholder="Lucide icon name (e.g., Network, Layers)"
                    />
                  </div>
                </div>
                
                {/* Layout Type */}
                <div>
                  <label className="block text-sm font-medium text-ink mb-3">Layout Type</label>
                  <div className="grid grid-cols-3 gap-3">
                    {LAYOUT_TYPES.map((layout) => (
                      <button
                        key={layout.value}
                        onClick={() => setView((prev) => ({
                          ...prev,
                          layout: { ...prev.layout!, type: layout.value as ViewConfiguration['layout']['type'] },
                        }))}
                        className={cn(
                          "p-4 rounded-xl border-2 text-left transition-all",
                          view.layout?.type === layout.value
                            ? "border-accent-lineage bg-accent-lineage/5"
                            : "border-glass-border hover:border-accent-lineage/50"
                        )}
                      >
                        <DynamicIcon name={layout.icon} className="w-6 h-6 mb-2 text-accent-lineage" />
                        <div className="font-medium text-sm">{layout.label}</div>
                        <div className="text-2xs text-ink-muted mt-1">{layout.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
            
            {activeTab === 'entities' && (
              <motion.div
                key="entities"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                <p className="text-sm text-ink-muted">
                  Select which entity types are visible in this view.
                </p>
                
                <div className="grid grid-cols-2 gap-3">
                  {schema?.entityTypes.map((entityType) => {
                    const isVisible = view.content?.visibleEntityTypes?.includes(entityType.id) ?? false
                    return (
                      <button
                        key={entityType.id}
                        onClick={() => toggleEntityType(entityType.id)}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border-2 text-left transition-all",
                          isVisible
                            ? "border-accent-lineage bg-accent-lineage/5"
                            : "border-glass-border hover:border-glass-border/80 opacity-50"
                        )}
                      >
                        <div 
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${entityType.visual.color}20` }}
                        >
                          <DynamicIcon 
                            name={entityType.visual.icon} 
                            className="w-4 h-4"
                            style={{ color: entityType.visual.color }}
                          />
                        </div>
                        <div>
                          <div className="font-medium text-sm">{entityType.name}</div>
                          <div className="text-2xs text-ink-muted">{entityType.pluralName}</div>
                        </div>
                        {isVisible && (
                          <LucideIcons.Check className="w-4 h-4 text-accent-lineage ml-auto" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </motion.div>
            )}
            
            {activeTab === 'projection' && (
              <motion.div
                key="projection"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-6"
              >
                <p className="text-sm text-ink-muted">
                  Configure how data is projected and aggregated in this view.
                </p>
                
                {/* Target Granularity */}
                <div>
                  <label className="block text-sm font-medium text-ink mb-3">Target Granularity</label>
                  <div className="space-y-2">
                    {GRANULARITY_LEVELS.map((level) => (
                      <button
                        key={level.value}
                        onClick={() => updateProjection('targetGranularity', level.value)}
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-lg border-2 text-left transition-all",
                          view.layout?.projection?.targetGranularity === level.value
                            ? "border-accent-lineage bg-accent-lineage/5"
                            : "border-glass-border hover:border-glass-border/80"
                        )}
                      >
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold",
                          view.layout?.projection?.targetGranularity === level.value
                            ? "bg-accent-lineage text-white"
                            : "bg-black/5 dark:bg-white/10 text-ink-muted"
                        )}>
                          L{level.value}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium text-sm">{level.label}</div>
                          <div className="text-2xs text-ink-muted">{level.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* Toggle Options */}
                <div className="space-y-3">
                  <ToggleOption
                    label="Aggregate Lineage"
                    description="Roll up column-level lineage to table-level"
                    enabled={view.layout?.projection?.aggregateLineage ?? false}
                    onChange={(v) => updateProjection('aggregateLineage', v)}
                  />
                  
                  <ToggleOption
                    label="Collapse Children"
                    description="Hide child entities and show count badges"
                    enabled={view.layout?.projection?.collapseChildren ?? false}
                    onChange={(v) => updateProjection('collapseChildren', v)}
                  />
                </div>
              </motion.div>
            )}
            
            {activeTab === 'layers' && (
              <motion.div
                key="layers"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm text-ink-muted">
                    Define horizontal layers for Reference Model layout.
                  </p>
                  <button onClick={addLayer} className="btn btn-primary btn-sm">
                    <LucideIcons.Plus className="w-4 h-4" />
                    Add Layer
                  </button>
                </div>
                
                {(view.layout?.referenceLayout?.layers ?? []).length === 0 ? (
                  <div className="text-center py-12 text-ink-muted">
                    <LucideIcons.LayoutTemplate className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>No layers defined yet</p>
                    <p className="text-2xs mt-1">Add layers to create a Reference Model view</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {(view.layout?.referenceLayout?.layers ?? [])
                      .sort((a, b) => a.order - b.order)
                      .map((layer, index) => (
                        <LayerEditor
                          key={layer.id}
                          layer={layer}
                          index={index}
                          entityTypes={schema?.entityTypes ?? []}
                          onUpdate={(updates) => updateLayer(layer.id, updates)}
                          onRemove={() => removeLayer(layer.id)}
                        />
                      ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-glass-border">
          <button onClick={onClose} className="btn btn-secondary btn-md">
            Cancel
          </button>
          <button onClick={handleSave} className="btn btn-primary btn-md">
            <LucideIcons.Save className="w-4 h-4" />
            Save View
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// Toggle option component
function ToggleOption({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string
  description: string
  enabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className={cn(
        "w-full flex items-center justify-between p-4 rounded-lg border-2 text-left transition-all",
        enabled
          ? "border-accent-lineage bg-accent-lineage/5"
          : "border-glass-border hover:border-glass-border/80"
      )}
    >
      <div>
        <div className="font-medium text-sm">{label}</div>
        <div className="text-2xs text-ink-muted">{description}</div>
      </div>
      <div className={cn(
        "w-12 h-6 rounded-full p-1 transition-colors",
        enabled ? "bg-accent-lineage" : "bg-black/10 dark:bg-white/10"
      )}>
        <div className={cn(
          "w-4 h-4 rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-6" : "translate-x-0"
        )} />
      </div>
    </button>
  )
}

// Layer editor component
function LayerEditor({
  layer,
  index,
  entityTypes,
  onUpdate,
  onRemove,
}: {
  layer: ViewLayerConfig
  index: number
  entityTypes: EntityTypeSchema[]
  onUpdate: (updates: Partial<ViewLayerConfig>) => void
  onRemove: () => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  
  return (
    <div className="rounded-lg border border-glass-border overflow-hidden">
      {/* Header */}
      <div 
        className="flex items-center gap-3 px-4 py-3 bg-canvas-elevated cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div 
          className="w-3 h-8 rounded"
          style={{ backgroundColor: layer.color }}
        />
        <div className="flex-1">
          <input
            type="text"
            value={layer.name}
            onChange={(e) => {
              e.stopPropagation()
              onUpdate({ name: e.target.value })
            }}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent font-medium text-sm focus:outline-none"
          />
          <div className="text-2xs text-ink-muted">
            {layer.entityTypes.length} entity types · Order: {index + 1}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="p-1.5 text-ink-muted hover:text-red-500 transition-colors"
        >
          <LucideIcons.Trash2 className="w-4 h-4" />
        </button>
        <LucideIcons.ChevronDown 
          className={cn(
            "w-4 h-4 text-ink-muted transition-transform",
            isExpanded && "rotate-180"
          )} 
        />
      </div>
      
      {/* Expanded Content */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 space-y-4 border-t border-glass-border">
              {/* Color Picker */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Color</label>
                <input
                  type="color"
                  value={layer.color}
                  onChange={(e) => onUpdate({ color: e.target.value })}
                  className="w-full h-8 rounded cursor-pointer"
                />
              </div>
              
              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">Description</label>
                <input
                  type="text"
                  value={layer.description ?? ''}
                  onChange={(e) => onUpdate({ description: e.target.value })}
                  className="input text-sm"
                  placeholder="e.g., Raw data sources"
                />
              </div>
              
              {/* Entity Types */}
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-2">Entity Types in this Layer</label>
                <div className="flex flex-wrap gap-2">
                  {entityTypes.map((et) => {
                    const isInLayer = layer.entityTypes.includes(et.id)
                    return (
                      <button
                        key={et.id}
                        onClick={() => {
                          const updated = isInLayer
                            ? layer.entityTypes.filter((id) => id !== et.id)
                            : [...layer.entityTypes, et.id]
                          onUpdate({ entityTypes: updated })
                        }}
                        className={cn(
                          "px-2 py-1 rounded-md text-xs font-medium transition-all",
                          isInLayer
                            ? "text-white"
                            : "bg-black/5 dark:bg-white/10 text-ink-muted hover:text-ink"
                        )}
                        style={isInLayer ? { backgroundColor: layer.color } : undefined}
                      >
                        {et.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ViewEditor

