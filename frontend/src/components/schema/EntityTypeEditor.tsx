import { useState } from 'react'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import type { EntityTypeSchema, EntityVisualConfig, EntityFieldDefinition } from '@/types/schema'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'

// Common Lucide icon names for picker
const COMMON_ICONS = [
  'FolderTree', 'Database', 'Table2', 'Columns3', 'Layers',
  'Box', 'Package', 'Workflow', 'GitBranch', 'Network',
  'LayoutDashboard', 'BarChart3', 'PieChart', 'LineChart',
  'Server', 'Cloud', 'HardDrive', 'Cpu', 'Globe',
  'Users', 'User', 'Building', 'Briefcase', 'FileCode',
  'Code', 'Terminal', 'Settings', 'Wrench', 'Cog',
]

// Color palette
const COLOR_PALETTE = [
  '#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#14b8a6',
  '#10b981', '#22c55e', '#84cc16', '#eab308', '#f59e0b',
  '#f97316', '#ef4444', '#ec4899', '#d946ef', '#a855f7',
  '#64748b', '#6b7280', '#71717a',
]

interface EntityTypeEditorProps {
  entityType?: EntityTypeSchema
  availableEntityTypes?: { id: string; name: string }[]
  readOnly?: boolean
  onSave: (entityType: EntityTypeSchema) => void
  onCancel: () => void
}

export function EntityTypeEditor({ entityType, availableEntityTypes = [], readOnly, onSave, onCancel }: EntityTypeEditorProps) {
  const isNew = !entityType

  const [form, setForm] = useState<EntityTypeSchema>(
    entityType || createDefaultEntityType()
  )

  const [activeTab, setActiveTab] = useState<'basic' | 'visual' | 'fields' | 'hierarchy'>('basic')

  const updateForm = <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const updateVisual = <K extends keyof EntityVisualConfig>(key: K, value: EntityVisualConfig[K]) => {
    setForm((prev) => ({ ...prev, visual: { ...prev.visual, [key]: value } }))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-glass-border">
        <div>
          <h2 className="text-lg font-display font-semibold">
            {isNew ? 'Create Entity Type' : 'Edit Entity Type'}
          </h2>
          <p className="text-sm text-ink-muted">
            Define how this type of entity appears and behaves
          </p>
        </div>
        <button onClick={onCancel} className="btn btn-ghost p-2">
          <LucideIcons.X className="w-5 h-5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-2 border-b border-glass-border">
        {(['basic', 'visual', 'fields', 'hierarchy'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              activeTab === tab
                ? "bg-accent-lineage/10 text-accent-lineage"
                : "text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
            )}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {activeTab === 'basic' && (
          <BasicTab form={form} updateForm={updateForm} readOnly={readOnly} />
        )}
        {activeTab === 'visual' && (
          <VisualTab form={form} updateVisual={updateVisual} readOnly={readOnly} />
        )}
        {activeTab === 'fields' && (
          <FieldsTab form={form} setForm={setForm} readOnly={readOnly} />
        )}
        {activeTab === 'hierarchy' && (
          <HierarchyTab form={form} updateForm={updateForm} availableEntityTypes={availableEntityTypes} readOnly={readOnly} />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between p-4 border-t border-glass-border">
        <button onClick={onCancel} className="btn btn-secondary btn-md">
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => onSave(form)}
              className="btn btn-primary btn-md"
            >
              {isNew ? 'Create Entity Type' : 'Stage Changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Basic Tab
interface BasicTabProps {
  form: EntityTypeSchema
  updateForm: <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => void
  readOnly?: boolean
}

function BasicTab({ form, updateForm, readOnly }: BasicTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-ink mb-1">
          Type ID <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={form.id}
          onChange={(e) => updateForm('id', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
          placeholder="e.g., dataset, pipeline, dashboard"
          className="input"
          disabled={readOnly}
        />
        <p className="text-2xs text-ink-muted mt-1">
          Unique identifier used in configuration and API
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-ink mb-1">
            Display Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => updateForm('name', e.target.value)}
            placeholder="e.g., Dataset"
            className="input"
            disabled={readOnly}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1">
            Plural Name
          </label>
          <input
            type="text"
            value={form.pluralName}
            onChange={(e) => updateForm('pluralName', e.target.value)}
            placeholder="e.g., Datasets"
            className="input"
            disabled={readOnly}
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-ink mb-1">
          Description
        </label>
        <textarea
          value={form.description || ''}
          onChange={(e) => updateForm('description', e.target.value)}
          placeholder="Describe what this entity type represents..."
          rows={3}
          className="input resize-none"
          disabled={readOnly}
        />
      </div>
    </div>
  )
}

// Visual Tab
interface VisualTabProps {
  form: EntityTypeSchema
  updateVisual: <K extends keyof EntityVisualConfig>(key: K, value: EntityVisualConfig[K]) => void
  readOnly?: boolean
}

function VisualTab({ form, updateVisual, readOnly }: VisualTabProps) {
  return (
    <div className="space-y-6">
      {/* Preview */}
      <div className="p-4 rounded-xl bg-canvas border border-glass-border">
        <p className="text-2xs text-ink-muted uppercase tracking-wider mb-3">Preview</p>
        <div className="flex justify-center">
          <EntityPreview visual={form.visual} name={form.name} />
        </div>
      </div>

      {/* Icon Picker */}
      <div className={cn(readOnly && 'opacity-60 pointer-events-none')}>
        <label className="block text-sm font-medium text-ink mb-2">Icon</label>
        <div className="grid grid-cols-10 gap-1 p-2 rounded-lg bg-canvas border border-glass-border">
          {COMMON_ICONS.map((iconName) => {
            const Icon = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[iconName]
            return (
              <button
                key={iconName}
                onClick={() => updateVisual('icon', iconName)}
                className={cn(
                  "w-8 h-8 rounded-md flex items-center justify-center transition-colors",
                  form.visual.icon === iconName
                    ? "bg-accent-lineage text-white"
                    : "hover:bg-black/5 dark:hover:bg-white/5 text-ink-secondary"
                )}
              >
                {Icon && <Icon className="w-4 h-4" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Color Picker */}
      <div className={cn(readOnly && 'opacity-60 pointer-events-none')}>
        <label className="block text-sm font-medium text-ink mb-2">Color</label>
        <div className="flex flex-wrap gap-2">
          {COLOR_PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => updateVisual('color', color)}
              className={cn(
                "w-8 h-8 rounded-lg transition-transform",
                form.visual.color === color && "ring-2 ring-offset-2 ring-ink scale-110"
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>

      {/* Shape */}
      <div className={cn(readOnly && 'opacity-60 pointer-events-none')}>
        <label className="block text-sm font-medium text-ink mb-2">Shape</label>
        <div className="flex items-center gap-2">
          {(['rectangle', 'rounded', 'pill'] as const).map((shape) => (
            <button
              key={shape}
              onClick={() => updateVisual('shape', shape)}
              className={cn(
                "px-4 py-2 border-2 transition-colors",
                shape === 'rectangle' ? 'rounded-md' :
                  shape === 'rounded' ? 'rounded-xl' : 'rounded-full',
                form.visual.shape === shape
                  ? "border-accent-lineage bg-accent-lineage/10"
                  : "border-glass-border hover:border-ink-muted"
              )}
            >
              <span className="text-sm capitalize">{shape}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Size */}
      <div className={cn(readOnly && 'opacity-60 pointer-events-none')}>
        <label className="block text-sm font-medium text-ink mb-2">Size</label>
        <div className="flex items-center gap-2">
          {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
            <button
              key={size}
              onClick={() => updateVisual('size', size)}
              className={cn(
                "px-3 py-1.5 rounded-lg border-2 text-sm uppercase transition-colors",
                form.visual.size === size
                  ? "border-accent-lineage bg-accent-lineage/10"
                  : "border-glass-border hover:border-ink-muted"
              )}
            >
              {size}
            </button>
          ))}
        </div>
      </div>

      {/* Border Style */}
      <div className={cn(readOnly && 'opacity-60 pointer-events-none')}>
        <label className="block text-sm font-medium text-ink mb-2">Border Style</label>
        <div className="flex items-center gap-2">
          {(['solid', 'dashed', 'dotted', 'none'] as const).map((style) => (
            <button
              key={style}
              onClick={() => updateVisual('borderStyle', style)}
              className={cn(
                "px-4 py-2 rounded-lg transition-colors",
                style === 'solid' ? 'border-2' :
                  style === 'dashed' ? 'border-2 border-dashed' :
                    style === 'dotted' ? 'border-2 border-dotted' : 'border-0 bg-black/5 dark:bg-white/5',
                form.visual.borderStyle === style
                  ? "border-accent-lineage"
                  : "border-glass-border"
              )}
            >
              <span className="text-sm capitalize">{style}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// Entity Preview Component
function EntityPreview({ visual, name }: { visual: EntityVisualConfig; name: string }) {
  const Icon = ((LucideIcons as any)[visual.icon] || LucideIcons.Box) as React.ComponentType<any>

  const sizeClasses = {
    xs: 'px-2 py-1.5 min-w-[100px]',
    sm: 'px-2.5 py-2 min-w-[140px]',
    md: 'px-3 py-2.5 min-w-[180px]',
    lg: 'px-4 py-3 min-w-[220px]',
    xl: 'px-5 py-4 min-w-[280px]',
  }

  const shapeClasses = {
    rectangle: 'rounded-md',
    rounded: 'rounded-xl',
    pill: 'rounded-full',
    diamond: 'rounded-lg',
    hexagon: 'rounded-lg',
    circle: 'rounded-full',
  }

  return (
    <motion.div
      layout
      className={cn(
        "bg-canvas-elevated border-2",
        sizeClasses[visual.size],
        shapeClasses[visual.shape],
        visual.borderStyle === 'dashed' && 'border-dashed',
        visual.borderStyle === 'dotted' && 'border-dotted',
      )}
      style={{
        borderColor: visual.color,
        borderLeftWidth: '4px',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${visual.color}15` }}
        >
          <Icon className="w-4 h-4" color={visual.color} />
        </div>
        <div>
          <span className="text-2xs font-medium uppercase" style={{ color: visual.color }}>
            {name}
          </span>
          <p className="text-sm font-medium text-ink">Example Entity</p>
        </div>
      </div>
    </motion.div>
  )
}

// Fields Tab
interface FieldsTabProps {
  form: EntityTypeSchema
  setForm: React.Dispatch<React.SetStateAction<EntityTypeSchema>>
  readOnly?: boolean
}

function FieldsTab({ form, setForm, readOnly }: FieldsTabProps) {
  const addField = () => {
    const newField: EntityFieldDefinition = {
      id: generateId('field'),
      name: 'New Field',
      type: 'string',
      required: false,
      showInNode: false,
      showInPanel: true,
      showInTooltip: false,
      displayOrder: form.fields.length,
    }
    setForm((prev) => ({
      ...prev,
      fields: [...prev.fields, newField],
    }))
  }

  const removeField = (fieldId: string) => {
    setForm((prev) => ({
      ...prev,
      fields: prev.fields.filter((f) => f.id !== fieldId),
    }))
  }

  const updateField = (fieldId: string, updates: Partial<EntityFieldDefinition>) => {
    setForm((prev) => ({
      ...prev,
      fields: prev.fields.map((f) =>
        f.id === fieldId ? { ...f, ...updates } : f
      ),
    }))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">Fields</h3>
          <p className="text-2xs text-ink-muted">Define the data fields for this entity type</p>
        </div>
        {!readOnly && (
          <button onClick={addField} className="btn btn-secondary btn-sm">
            <LucideIcons.Plus className="w-4 h-4" />
            Add Field
          </button>
        )}
      </div>

      <div className="space-y-2">
        {form.fields.map((field) => (
          <div
            key={field.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-glass-border bg-canvas"
          >
            <LucideIcons.GripVertical className="w-4 h-4 text-ink-muted cursor-grab" />

            <input
              type="text"
              value={field.name}
              onChange={(e) => updateField(field.id, { name: e.target.value })}
              className="input py-1 px-2 w-32"
              placeholder="Field name"
              disabled={readOnly}
            />

            <select
              value={field.type}
              onChange={(e) => updateField(field.id, { type: e.target.value as EntityFieldDefinition['type'] })}
              className="input py-1 px-2 w-28"
              disabled={readOnly}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="date">Date</option>
              <option value="urn">URN</option>
              <option value="tags">Tags</option>
              <option value="badge">Badge</option>
              <option value="progress">Progress</option>
              <option value="status">Status</option>
              <option value="user">User</option>
            </select>

            <label className="flex items-center gap-1 text-2xs text-ink-muted">
              <input
                type="checkbox"
                checked={field.showInNode}
                onChange={(e) => updateField(field.id, { showInNode: e.target.checked })}
                className="w-3 h-3"
                disabled={readOnly}
              />
              Node
            </label>

            <label className="flex items-center gap-1 text-2xs text-ink-muted">
              <input
                type="checkbox"
                checked={field.showInPanel}
                onChange={(e) => updateField(field.id, { showInPanel: e.target.checked })}
                className="w-3 h-3"
                disabled={readOnly}
              />
              Panel
            </label>

            <label className="flex items-center gap-1 text-2xs text-ink-muted">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => updateField(field.id, { required: e.target.checked })}
                className="w-3 h-3"
                disabled={readOnly}
              />
              Required
            </label>

            {!readOnly && (
              <button
                onClick={() => removeField(field.id)}
                className="ml-auto p-1 rounded hover:bg-red-500/10 text-ink-muted hover:text-red-500"
              >
                <LucideIcons.Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Hierarchy Tab
interface HierarchyTabProps {
  form: EntityTypeSchema
  availableEntityTypes: { id: string; name: string }[]
  updateForm: <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => void
  readOnly?: boolean
}

function HierarchyTab({ form, availableEntityTypes, updateForm, readOnly }: HierarchyTabProps) {
  const updateHierarchy = <K extends keyof typeof form.hierarchy>(
    key: K,
    value: typeof form.hierarchy[K]
  ) => {
    updateForm('hierarchy', { ...form.hierarchy, [key]: value })
  }

  // Types available as children (exclude self)
  const childCandidates = availableEntityTypes.filter(t => t.id !== form.id)
  const parentCandidates = availableEntityTypes.filter(t => t.id !== form.id)

  function toggleChild(typeId: string) {
    const current = form.hierarchy.canContain
    const next = current.includes(typeId)
      ? current.filter(c => c !== typeId)
      : [...current, typeId]
    updateHierarchy('canContain', next)
  }

  function toggleParent(typeId: string) {
    const current = form.hierarchy.canBeContainedBy
    const next = current.includes(typeId)
      ? current.filter(p => p !== typeId)
      : [...current, typeId]
    updateHierarchy('canBeContainedBy', next)
  }

  const isRoot = form.hierarchy.canBeContainedBy.length === 0

  return (
    <div className="space-y-6">
      {/* Root status indicator */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium',
        isRoot
          ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
          : 'bg-black/5 dark:bg-white/5 text-ink-muted border border-glass-border'
      )}>
        <LucideIcons.Crown className={cn('w-3.5 h-3.5', isRoot ? 'text-amber-500' : 'opacity-30')} />
        {isRoot ? 'Root type — no parent (top of hierarchy)' : 'Has parent(s) — nested in hierarchy'}
      </div>

      {/* Can Contain — chip selector */}
      <div>
        <label className="block text-sm font-semibold text-ink mb-1">
          Can Contain <span className="text-ink-muted font-normal">(child types)</span>
        </label>
        <p className="text-[11px] text-ink-muted mb-2">
          Types this entity can parent in the containment hierarchy
        </p>
        {childCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted italic">No other entity types defined yet</p>
        ) : (
          <div className={cn('flex flex-wrap gap-1.5', readOnly && 'opacity-60 pointer-events-none')}>
            {childCandidates.map(t => {
              const selected = form.hierarchy.canContain.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleChild(t.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-medium border transition-all',
                    selected
                      ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700'
                      : 'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border hover:border-indigo-300 hover:text-indigo-600'
                  )}
                >
                  {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Can Be Contained By — chip selector */}
      <div>
        <label className="block text-sm font-semibold text-ink mb-1">
          Can Be Contained By <span className="text-ink-muted font-normal">(parent types)</span>
        </label>
        <p className="text-[11px] text-ink-muted mb-2">
          Types that can parent this entity. Leave empty to make this a root type.
        </p>
        {parentCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted italic">No other entity types defined yet</p>
        ) : (
          <div className={cn('flex flex-wrap gap-1.5', readOnly && 'opacity-60 pointer-events-none')}>
            {parentCandidates.map(t => {
              const selected = form.hierarchy.canBeContainedBy.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleParent(t.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-medium border transition-all',
                    selected
                      ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700'
                      : 'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border hover:border-green-300 hover:text-green-600'
                  )}
                >
                  {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Level — read-only computed hint with manual override */}
      <div>
        <label className="block text-sm font-semibold text-ink mb-1">
          Hierarchy Level
        </label>
        <p className="text-[11px] text-ink-muted mb-2">
          Usually auto-computed from tree depth in the Hierarchy Map tab. Override only if needed.
        </p>
        <input
          type="number"
          value={form.hierarchy.level}
          onChange={(e) => updateHierarchy('level', parseInt(e.target.value) || 0)}
          min={0}
          max={20}
          className="input w-20"
          disabled={readOnly}
        />
      </div>

      {/* Expanded by default */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={form.hierarchy.defaultExpanded}
            onChange={(e) => updateHierarchy('defaultExpanded', e.target.checked)}
            className="w-4 h-4 rounded"
            disabled={readOnly}
          />
          <div>
            <span className="text-sm font-medium text-ink">Expanded by Default</span>
            <p className="text-[11px] text-ink-muted">Show children automatically when this type is first rendered in a view</p>
          </div>
        </label>
      </div>
    </div>
  )
}

// Helper to create default entity type
function createDefaultEntityType(): EntityTypeSchema {
  return {
    id: '',
    name: 'New Entity Type',
    pluralName: 'New Entity Types',
    description: '',
    visual: {
      icon: 'Box',
      color: '#6366f1',
      shape: 'rounded',
      size: 'md',
      borderStyle: 'solid',
      showInMinimap: true,
    },
    fields: [
      { id: 'name', name: 'Name', type: 'string', required: true, showInNode: true, showInPanel: true, showInTooltip: true, displayOrder: 1 },
    ],
    hierarchy: {
      level: 1,
      canContain: [],
      canBeContainedBy: [],
      defaultExpanded: false,
      rollUpFields: [],
    },
    behavior: {
      selectable: true,
      draggable: true,
      expandable: true,
      traceable: true,
      clickAction: 'select',
      doubleClickAction: 'panel',
    },
  }
}

