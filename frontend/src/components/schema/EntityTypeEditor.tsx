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

const TAB_DEFS = [
  { id: 'basic' as const, label: 'Identity', icon: LucideIcons.FileText },
  { id: 'visual' as const, label: 'Appearance', icon: LucideIcons.Palette },
  { id: 'fields' as const, label: 'Fields', icon: LucideIcons.List },
  { id: 'hierarchy' as const, label: 'Hierarchy', icon: LucideIcons.FolderTree },
]

const FIELD_TYPE_OPTIONS: Array<{ value: EntityFieldDefinition['type']; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'string', label: 'String', icon: LucideIcons.Type },
  { value: 'number', label: 'Number', icon: LucideIcons.Hash },
  { value: 'boolean', label: 'Boolean', icon: LucideIcons.ToggleLeft },
  { value: 'date', label: 'Date', icon: LucideIcons.Calendar },
  { value: 'urn', label: 'URN', icon: LucideIcons.Link },
  { value: 'tags', label: 'Tags', icon: LucideIcons.Tags },
  { value: 'badge', label: 'Badge', icon: LucideIcons.Award },
  { value: 'progress', label: 'Progress', icon: LucideIcons.BarChart3 },
  { value: 'status', label: 'Status', icon: LucideIcons.CircleDot },
  { value: 'user', label: 'User', icon: LucideIcons.User },
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

  const canSave = form.name.trim() && form.id.trim()

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tabs — underline style matching page tabs */}
      <div className="flex items-center border-b border-glass-border px-4 shrink-0">
        {TAB_DEFS.map(t => {
          const Icon = t.icon
          const isActive = activeTab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-3 text-xs font-semibold transition-all border-b-2',
                isActive
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <fieldset disabled={readOnly} className={cn(readOnly && 'opacity-75')}>
          <div className="p-5">
            {activeTab === 'basic' && (
              <BasicTab form={form} updateForm={updateForm} isNew={isNew} />
            )}
            {activeTab === 'visual' && (
              <VisualTab form={form} updateVisual={updateVisual} />
            )}
            {activeTab === 'fields' && (
              <FieldsTab form={form} setForm={setForm} readOnly={readOnly} />
            )}
            {activeTab === 'hierarchy' && (
              <HierarchyTab form={form} updateForm={updateForm} availableEntityTypes={availableEntityTypes} />
            )}
          </div>
        </fieldset>
      </div>

      {/* Footer — prominent action bar */}
      <div className="flex items-center justify-between px-5 py-4 border-t border-glass-border bg-canvas-elevated/50">
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-all"
        >
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button
            onClick={() => onSave(form)}
            disabled={!canSave}
            className={cn(
              'flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all',
              canSave
                ? 'bg-indigo-500 text-white hover:bg-indigo-600 shadow-md shadow-indigo-500/25 hover:shadow-lg'
                : 'bg-indigo-500/40 text-white/60 cursor-not-allowed',
            )}
          >
            <LucideIcons.Check className="w-4 h-4" />
            {isNew ? 'Create Entity Type' : 'Stage Changes'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section wrapper for consistent styling
// ---------------------------------------------------------------------------

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <h3 className="text-xs font-bold text-ink-muted uppercase tracking-wider mb-1">{title}</h3>
      {description && <p className="text-[11px] text-ink-muted/70 mb-3">{description}</p>}
      {!description && <div className="mb-3" />}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Basic Tab
// ---------------------------------------------------------------------------

function BasicTab({ form, updateForm, isNew }: {
  form: EntityTypeSchema
  updateForm: <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => void
  isNew: boolean
}) {
  return (
    <div className="space-y-5">
      <Section title="Identification">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1.5">
              Type ID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => updateForm('id', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              placeholder="e.g., dataset, pipeline, dashboard"
              className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all"
              disabled={!isNew}
            />
            <p className="text-[10px] text-ink-muted/60 mt-1">Unique identifier — cannot be changed after creation</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink mb-1.5">
                Display Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => updateForm('name', e.target.value)}
                placeholder="e.g., Dataset"
                className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink mb-1.5">Plural Name</label>
              <input
                type="text"
                value={form.pluralName}
                onChange={(e) => updateForm('pluralName', e.target.value)}
                placeholder="e.g., Datasets"
                className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink mb-1.5">Description</label>
            <textarea
              value={form.description || ''}
              onChange={(e) => updateForm('description', e.target.value)}
              placeholder="Describe what this entity type represents..."
              rows={2}
              className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500/20 transition-all resize-none"
            />
          </div>
        </div>
      </Section>

      <Section title="Behavior" description="How this entity type behaves in the graph">
        <div className="space-y-2">
          {([
            { key: 'traceable' as const, label: 'Traceable', desc: 'Include in lineage traces', icon: LucideIcons.Route },
            { key: 'expandable' as const, label: 'Expandable', desc: 'Can expand to show children', icon: LucideIcons.Maximize2 },
            { key: 'draggable' as const, label: 'Draggable', desc: 'Can be repositioned on canvas', icon: LucideIcons.Move },
          ]).map(({ key, label, desc, icon: Icon }) => (
            <label
              key={key}
              className={cn(
                'flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all',
                form.behavior[key]
                  ? 'border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/50 dark:bg-indigo-950/20'
                  : 'border-glass-border hover:border-glass-border-hover hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
              )}
            >
              <Icon className={cn('w-4 h-4 flex-shrink-0', form.behavior[key] ? 'text-indigo-500' : 'text-ink-muted/50')} />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-ink">{label}</span>
                <p className="text-[10px] text-ink-muted">{desc}</p>
              </div>
              <input
                type="checkbox"
                checked={form.behavior[key]}
                onChange={(e) => updateForm('behavior', { ...form.behavior, [key]: e.target.checked })}
                className="w-4 h-4 rounded accent-indigo-500"
              />
            </label>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Visual Tab
// ---------------------------------------------------------------------------

function VisualTab({ form, updateVisual }: {
  form: EntityTypeSchema
  updateVisual: <K extends keyof EntityVisualConfig>(key: K, value: EntityVisualConfig[K]) => void
}) {
  return (
    <div className="space-y-5">
      {/* Live Preview */}
      <div className="p-5 rounded-2xl bg-gradient-to-br from-black/[0.02] to-black/[0.04] dark:from-white/[0.02] dark:to-white/[0.04] border border-glass-border">
        <p className="text-[10px] text-ink-muted uppercase tracking-widest font-bold mb-3">Live Preview</p>
        <div className="flex justify-center py-2">
          <EntityPreview visual={form.visual} name={form.name} />
        </div>
      </div>

      <Section title="Icon">
        <div className="grid grid-cols-10 gap-1 p-2 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-glass-border">
          {COMMON_ICONS.map((iconName) => {
            const Icon = (LucideIcons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[iconName]
            const selected = form.visual.icon === iconName
            return (
              <button
                key={iconName}
                onClick={() => updateVisual('icon', iconName)}
                className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center transition-all',
                  selected
                    ? 'bg-indigo-500 text-white shadow-sm shadow-indigo-500/30 scale-110'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-ink-secondary hover:text-ink',
                )}
              >
                {Icon && <Icon className="w-4 h-4" />}
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="Color">
        <div className="flex flex-wrap gap-1.5">
          {COLOR_PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => updateVisual('color', color)}
              className={cn(
                'w-8 h-8 rounded-lg transition-all',
                form.visual.color === color
                  ? 'ring-2 ring-offset-2 ring-offset-canvas ring-ink scale-110 shadow-md'
                  : 'hover:scale-110',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Section title="Shape">
          <div className="flex flex-col gap-1.5">
            {(['rectangle', 'rounded', 'pill'] as const).map((shape) => (
              <button
                key={shape}
                onClick={() => updateVisual('shape', shape)}
                className={cn(
                  'px-3 py-2 text-left text-xs font-medium border transition-all',
                  shape === 'rectangle' ? 'rounded-md' :
                    shape === 'rounded' ? 'rounded-xl' : 'rounded-full',
                  form.visual.shape === shape
                    ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400'
                    : 'border-glass-border hover:border-glass-border-hover text-ink-secondary',
                )}
              >
                <span className="capitalize">{shape}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Size">
          <div className="flex flex-col gap-1.5">
            {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
              <button
                key={size}
                onClick={() => updateVisual('size', size)}
                className={cn(
                  'px-3 py-2 rounded-xl text-left text-xs font-medium border transition-all',
                  form.visual.size === size
                    ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400'
                    : 'border-glass-border hover:border-glass-border-hover text-ink-secondary',
                )}
              >
                <span className="uppercase">{size}</span>
              </button>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Border Style">
        <div className="flex items-center gap-1.5">
          {(['solid', 'dashed', 'dotted', 'none'] as const).map((style) => (
            <button
              key={style}
              onClick={() => updateVisual('borderStyle', style)}
              className={cn(
                'flex-1 px-3 py-2 rounded-xl text-xs font-medium transition-all',
                style === 'solid' ? 'border-2' :
                  style === 'dashed' ? 'border-2 border-dashed' :
                    style === 'dotted' ? 'border-2 border-dotted' : 'border-2 border-transparent bg-black/5 dark:bg-white/5',
                form.visual.borderStyle === style
                  ? 'border-indigo-400 text-indigo-600 dark:text-indigo-400'
                  : 'border-glass-border text-ink-secondary',
              )}
            >
              <span className="capitalize">{style}</span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Entity Preview
// ---------------------------------------------------------------------------

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
        'bg-canvas-elevated border-2 shadow-lg',
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
            {name || 'Entity'}
          </span>
          <p className="text-sm font-medium text-ink">Example Entity</p>
        </div>
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Fields Tab
// ---------------------------------------------------------------------------

function FieldsTab({ form, setForm, readOnly }: {
  form: EntityTypeSchema
  setForm: React.Dispatch<React.SetStateAction<EntityTypeSchema>>
  readOnly?: boolean
}) {
  const addField = () => {
    const newField: EntityFieldDefinition = {
      id: generateId('field'),
      name: '',
      type: 'string',
      required: false,
      showInNode: false,
      showInPanel: true,
      showInTooltip: false,
      displayOrder: form.fields.length,
    }
    setForm((prev) => ({ ...prev, fields: [...prev.fields, newField] }))
  }

  const removeField = (fieldId: string) => {
    setForm((prev) => ({ ...prev, fields: prev.fields.filter((f) => f.id !== fieldId) }))
  }

  const updateField = (fieldId: string, updates: Partial<EntityFieldDefinition>) => {
    setForm((prev) => ({
      ...prev,
      fields: prev.fields.map((f) => f.id === fieldId ? { ...f, ...updates } : f),
    }))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Fields</h3>
          <p className="text-[10px] text-ink-muted/70 mt-0.5">{form.fields.length} field{form.fields.length !== 1 ? 's' : ''} defined</p>
        </div>
        {!readOnly && (
          <button
            onClick={addField}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 transition-all"
          >
            <LucideIcons.Plus className="w-3.5 h-3.5" />
            Add Field
          </button>
        )}
      </div>

      {form.fields.length === 0 ? (
        <div className="text-center py-8 rounded-xl border-2 border-dashed border-glass-border">
          <LucideIcons.List className="w-6 h-6 mx-auto mb-2 text-ink-muted/30" />
          <p className="text-xs text-ink-muted">No fields defined yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {form.fields.map((field) => (
            <div
              key={field.id}
              className="rounded-xl border border-glass-border bg-canvas hover:border-glass-border-hover transition-all overflow-hidden"
            >
              {/* Field header row */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <LucideIcons.GripVertical className="w-3.5 h-3.5 text-ink-muted/40 cursor-grab flex-shrink-0" />

                <input
                  type="text"
                  value={field.name}
                  onChange={(e) => updateField(field.id, { name: e.target.value })}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-transparent border border-transparent hover:border-glass-border focus:border-indigo-500/30 focus:bg-black/[0.02] dark:focus:bg-white/[0.02] text-sm font-medium text-ink placeholder:text-ink-muted/50 focus:outline-none transition-all"
                  placeholder="Field name"
                  disabled={readOnly}
                />

                <select
                  value={field.type}
                  onChange={(e) => updateField(field.id, { type: e.target.value as EntityFieldDefinition['type'] })}
                  className="px-2 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs text-ink-secondary font-medium focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                  disabled={readOnly}
                >
                  {FIELD_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                {!readOnly && (
                  <button
                    onClick={() => removeField(field.id)}
                    className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-ink-muted/40 hover:text-red-500 transition-colors flex-shrink-0"
                  >
                    <LucideIcons.Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Field options row */}
              <div className="flex items-center gap-3 px-3 py-1.5 bg-black/[0.015] dark:bg-white/[0.015] border-t border-glass-border/50">
                {([
                  { key: 'showInNode' as const, label: 'Node' },
                  { key: 'showInPanel' as const, label: 'Panel' },
                  { key: 'showInTooltip' as const, label: 'Tooltip' },
                  { key: 'required' as const, label: 'Required' },
                ] as const).map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={field[key]}
                      onChange={(e) => updateField(field.id, { [key]: e.target.checked })}
                      className="w-3 h-3 rounded accent-indigo-500"
                      disabled={readOnly}
                    />
                    <span className="text-[10px] text-ink-muted font-medium">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hierarchy Tab
// ---------------------------------------------------------------------------

function HierarchyTab({ form, availableEntityTypes, updateForm }: {
  form: EntityTypeSchema
  availableEntityTypes: { id: string; name: string }[]
  updateForm: <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => void
}) {
  const updateHierarchy = <K extends keyof typeof form.hierarchy>(
    key: K,
    value: typeof form.hierarchy[K]
  ) => {
    updateForm('hierarchy', { ...form.hierarchy, [key]: value })
  }

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
    <div className="space-y-5">
      {/* Root status */}
      <div className={cn(
        'flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-xs font-semibold',
        isRoot
          ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
          : 'bg-black/[0.03] dark:bg-white/[0.03] text-ink-muted border border-glass-border',
      )}>
        <LucideIcons.Crown className={cn('w-4 h-4', isRoot ? 'text-amber-500' : 'opacity-30')} />
        {isRoot ? 'Root type — top of hierarchy' : 'Nested — has parent type(s)'}
      </div>

      <Section title="Can Contain" description="Child types this entity can parent in the hierarchy">
        {childCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted/60 italic">No other entity types defined</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {childCandidates.map(t => {
              const selected = form.hierarchy.canContain.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleChild(t.id)}
                  className={cn(
                    'px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all',
                    selected
                      ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700 shadow-sm'
                      : 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border hover:border-indigo-300 hover:text-indigo-600',
                  )}
                >
                  {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="Can Be Contained By" description="Parent types. Leave empty for a root type.">
        {parentCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted/60 italic">No other entity types defined</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {parentCandidates.map(t => {
              const selected = form.hierarchy.canBeContainedBy.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleParent(t.id)}
                  className={cn(
                    'px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-all',
                    selected
                      ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700 shadow-sm'
                      : 'bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted border-glass-border hover:border-green-300 hover:text-green-600',
                  )}
                >
                  {selected && <LucideIcons.Check className="w-2.5 h-2.5 inline mr-1" />}
                  {t.name}
                </button>
              )
            })}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Section title="Hierarchy Level">
          <input
            type="number"
            value={form.hierarchy.level}
            onChange={(e) => updateHierarchy('level', parseInt(e.target.value) || 0)}
            min={0}
            max={20}
            className="w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/30 transition-all"
          />
        </Section>

        <Section title="Default State">
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-all">
            <input
              type="checkbox"
              checked={form.hierarchy.defaultExpanded}
              onChange={(e) => updateHierarchy('defaultExpanded', e.target.checked)}
              className="w-4 h-4 rounded accent-indigo-500"
            />
            <span className="text-xs font-medium text-ink">Expanded</span>
          </label>
        </Section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Default entity type factory
// ---------------------------------------------------------------------------

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
