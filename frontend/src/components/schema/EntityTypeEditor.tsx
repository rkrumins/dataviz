import { useState, useMemo } from 'react'
import { Reorder } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import type { EntityTypeSchema, EntityVisualConfig, EntityFieldDefinition } from '@/types/schema'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/utils'
import { toEntityTypeId, findCaseInsensitiveCollision } from '@/features/ontology/lib/typeIds'
import { IconPicker } from '@/components/ui/IconPicker'
import { NodePreview } from '@/components/schema/NodePreview'
import { ColorInput } from '@/components/ui/ColorInput'

// Curated icons surfaced as the "Suggested" row of the full-catalog picker.
const COMMON_ICONS = [
  'FolderTree', 'Database', 'Table2', 'Columns3', 'Layers',
  'Box', 'Package', 'Workflow', 'GitBranch', 'Network',
  'LayoutDashboard', 'BarChart3', 'PieChart', 'LineChart',
  'Server', 'Cloud', 'HardDrive', 'Cpu', 'Globe',
  'Users', 'User', 'Building', 'Briefcase', 'FileCode',
  'Code', 'Terminal', 'Settings', 'Wrench', 'Cog',
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

  const [form, setForm] = useState<EntityTypeSchema>(() => {
    // Present fields in their declared display order (drag-reorder rewrites it).
    const base = entityType
      ? { ...entityType, fields: [...entityType.fields].sort((a, b) => a.displayOrder - b.displayOrder) }
      : createDefaultEntityType()
    // New types derive their node-label id from the name up-front.
    return entityType ? base : { ...base, id: toEntityTypeId(base.name) }
  })
  // Once the id is hand-edited, stop auto-deriving it from the name (slug-field pattern).
  const [idTouched, setIdTouched] = useState(false)

  const [activeTab, setActiveTab] = useState<'basic' | 'visual' | 'fields' | 'hierarchy'>('basic')

  const updateForm = <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // The physical node label is `form.id`. New types derive it from the name as PascalCase
  // (until hand-edited); existing types keep theirs frozen so live nodes keep resolving.
  const onNameChange = (name: string) =>
    setForm((p) => ({ ...p, name, id: isNew && !idTouched ? toEntityTypeId(name) : p.id }))
  const onIdChange = (raw: string) => {
    setIdTouched(true)
    setForm((p) => ({ ...p, id: toEntityTypeId(raw) }))
  }

  const updateVisual = <K extends keyof EntityVisualConfig>(key: K, value: EntityVisualConfig[K]) => {
    setForm((prev) => ({ ...prev, visual: { ...prev.visual, [key]: value } }))
  }

  // Uniqueness is scoped to THIS ontology, excluding the type being edited.
  const otherIds = useMemo(
    () => availableEntityTypes.map((t) => t.id).filter((id) => id !== entityType?.id),
    [availableEntityTypes, entityType?.id],
  )
  const collision = findCaseInsensitiveCollision(form.id, otherIds)
  const canSave = !!form.name.trim() && !!form.id.trim() && !collision

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

      {/* Read-only banner for immutable ontologies */}
      {readOnly && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <LucideIcons.Lock className="w-3.5 h-3.5 flex-shrink-0" />
          <span>This schema is locked. <strong>Clone</strong> it to make edits.</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <fieldset disabled={readOnly} className={cn(readOnly && 'opacity-75')}>
          <div className="p-5">
            {activeTab === 'basic' && (
              <BasicTab
                form={form}
                updateForm={updateForm}
                isNew={isNew}
                onNameChange={onNameChange}
                onIdChange={onIdChange}
                collision={collision}
              />
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

function BasicTab({ form, updateForm, isNew, onNameChange, onIdChange, collision }: {
  form: EntityTypeSchema
  updateForm: <K extends keyof EntityTypeSchema>(key: K, value: EntityTypeSchema[K]) => void
  isNew: boolean
  onNameChange: (name: string) => void
  onIdChange: (raw: string) => void
  collision: string | null
}) {
  return (
    <div className="space-y-5">
      <Section title="Identification">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-ink mb-1.5">
                Display Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => onNameChange(e.target.value)}
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

          {/* Physical node label — the id written to the graph. */}
          <div>
            <label className="block text-xs font-semibold text-ink mb-1.5">
              Node label <span className="text-red-500">*</span>
              <span className="ml-1.5 font-normal text-ink-muted">— how it appears in the graph</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-ink-muted/70 pointer-events-none select-none">:</span>
              <input
                type="text"
                value={form.id}
                onChange={(e) => onIdChange(e.target.value)}
                disabled={!isNew}
                placeholder="Dataset"
                spellCheck={false}
                className={cn(
                  'w-full pl-6 pr-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border text-sm font-mono text-ink placeholder:text-ink-muted/40 focus:outline-none focus:ring-2 transition-all disabled:opacity-70',
                  collision
                    ? 'border-red-400/70 focus:ring-red-500/25 focus:border-red-400/40'
                    : 'border-glass-border focus:ring-indigo-500/30 focus:border-indigo-500/20',
                )}
              />
            </div>
            {collision ? (
              <p className="text-[11px] text-red-600 dark:text-red-400 mt-1 flex items-center gap-1">
                <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
                <span><span className="font-mono">{collision}</span> already exists in this ontology — choose a different name.</span>
              </p>
            ) : (
              <p className="text-[10px] text-ink-muted/70 mt-1">
                {isNew
                  ? 'Auto-generated from the name (PascalCase). Unique within this ontology — other ontologies can reuse it.'
                  : 'Fixed after creation so existing nodes keep resolving. Rename the display name freely; this stays put.'}
              </p>
            )}
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
      {/* Live Preview — the REAL canvas node, fed the unsaved form state */}
      <div className="p-3 rounded-2xl bg-gradient-to-br from-black/[0.02] to-black/[0.04] dark:from-white/[0.02] dark:to-white/[0.04] border border-glass-border">
        <p className="text-[10px] text-ink-muted uppercase tracking-widest font-bold mb-1 px-2 pt-1">Live Canvas Preview</p>
        <NodePreview entityType={form} />
      </div>

      <Section title="Icon">
        <IconPicker
          value={form.visual.icon}
          onChange={name => updateVisual('icon', name)}
          suggested={COMMON_ICONS}
        />
      </Section>

      <Section title="Color">
        <ColorInput
          value={form.visual.color}
          onChange={color => updateVisual('color', color)}
        />
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

  // Drag-reorder: rewrite displayOrder sequentially so persisted order matches.
  const reorderFields = (ordered: EntityFieldDefinition[]) => {
    setForm((prev) => ({
      ...prev,
      fields: ordered.map((f, i) => ({ ...f, displayOrder: i })),
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
        <Reorder.Group axis="y" values={form.fields} onReorder={reorderFields} className="space-y-2">
          {form.fields.map((field) => (
            <Reorder.Item
              key={field.id}
              value={field}
              drag={readOnly ? false : 'y'}
              className="rounded-xl border border-glass-border bg-canvas hover:border-glass-border-hover transition-colors overflow-hidden"
            >
              {/* Field header row */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <LucideIcons.GripVertical className={cn('w-3.5 h-3.5 text-ink-muted/40 flex-shrink-0', readOnly ? 'opacity-30' : 'cursor-grab active:cursor-grabbing')} />

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
            </Reorder.Item>
          ))}
        </Reorder.Group>
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

  // DAG-aware: a type may appear in its own can_contain / can_be_contained_by
  // lists to express recursive nesting (e.g. Domain contains Domain). The
  // backend treats this as a first-class case; surface it here as well.
  const childCandidates = availableEntityTypes
  const parentCandidates = availableEntityTypes

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

      <Section title="Can Contain" description="Child types this entity can parent. Select this type itself to allow recursive nesting.">
        {childCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted/60 italic">No entity types defined</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {childCandidates.map(t => {
              const selected = form.hierarchy.canContain.includes(t.id)
              const isSelf = t.id === form.id
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
                  {isSelf && <LucideIcons.Repeat className="w-2.5 h-2.5 inline mr-1 opacity-80" />}
                  {t.name}
                  {isSelf && <span className="ml-1 opacity-70">(self)</span>}
                </button>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="Can Be Contained By" description="Parent types. Leave empty for a root type. Include this type itself for recursive nesting.">
        {parentCandidates.length === 0 ? (
          <p className="text-xs text-ink-muted/60 italic">No entity types defined</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {parentCandidates.map(t => {
              const selected = form.hierarchy.canBeContainedBy.includes(t.id)
              const isSelf = t.id === form.id
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
                  {isSelf && <LucideIcons.Repeat className="w-2.5 h-2.5 inline mr-1 opacity-80" />}
                  {t.name}
                  {isSelf && <span className="ml-1 opacity-70">(self)</span>}
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
