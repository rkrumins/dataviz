/**
 * FieldsTab — a type's fields, as the entity and relationship type editors edit them: each a
 * property by its key, of a type, required or not, held to allowed values or not. A new field's
 * key follows its name until typed; a saved one's is fixed — the values are held under it.
 *
 * An entity type's fields also say where a value shows (node, panel, tooltip), whether an import
 * matches by it and whether it is unique. A relationship type's don't: nothing reads those of a
 * relationship.
 */
import { useId, useState } from 'react'
import { Reorder } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import type { EntityFieldDefinition } from '@/types/schema'
import { cn, generateId } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { AllowedValuesEditor } from './AllowedValuesEditor'

const FIELD_TYPE_OPTIONS: Array<{ value: EntityFieldDefinition['type']; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'string', label: 'String', icon: LucideIcons.Type },
  { value: 'number', label: 'Number', icon: LucideIcons.Hash },
  { value: 'boolean', label: 'Boolean', icon: LucideIcons.ToggleLeft },
  { value: 'date', label: 'Date', icon: LucideIcons.Calendar },
  { value: 'datetime', label: 'Date & time', icon: LucideIcons.CalendarClock },
  { value: 'url', label: 'Link', icon: LucideIcons.Link2 },
  { value: 'email', label: 'Email', icon: LucideIcons.AtSign },
  { value: 'urn', label: 'URN', icon: LucideIcons.Link },
  { value: 'tags', label: 'Tags', icon: LucideIcons.Tags },
  { value: 'badge', label: 'Badge', icon: LucideIcons.Award },
  { value: 'progress', label: 'Progress', icon: LucideIcons.BarChart3 },
  { value: 'status', label: 'Status', icon: LucideIcons.CircleDot },
  { value: 'user', label: 'User', icon: LucideIcons.User },
]

/** A field's property key from its name, as a new field takes it until the key is typed: lower
 *  case, words joined by `_` ("SAP id" → `sap_id`). */
function toPropertyKey(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** The longest property key: the longest a search can look a property up by. */
const KEY_MAX = 128

/** Why each NEW field's property key can't be saved (by index; a saved field's is its own, left as
 *  it is) — none: each has a key, no other field of the type has. */
export function fieldKeyProblems(fields: readonly EntityFieldDefinition[], isNew: (f: EntityFieldDefinition) => boolean): Array<string | null> {
  const seen = new Map<string, number>()
  for (const f of fields) seen.set(f.id.trim(), (seen.get(f.id.trim()) ?? 0) + 1)
  return fields.map((f) => {
    const key = f.id.trim()
    if (!isNew(f)) return null
    if (!key) return 'Give it a property key — the property it reads and writes'
    if (key.length > KEY_MAX) return `Property keys are at most ${KEY_MAX} characters`
    if ((seen.get(key) ?? 0) > 1) return 'Another field of this type uses this key'
    return null
  })
}

/** Each field row's own key, kept while its id — the property key — is typed (a new field's id
 *  follows its name until the key is edited), and which rows are new: only theirs can be typed.
 *  A saved field's id is fixed — entities hold their values under it. */
export function useFieldRows() {
  const [rowKeys] = useState(() => new WeakMap<EntityFieldDefinition, string>())
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const keyOf = (f: EntityFieldDefinition) => {
    let k = rowKeys.get(f)
    if (!k) { k = f.id || generateId('field'); rowKeys.set(f, k) }
    return k
  }
  return {
    keyOf,
    /** `next` is the row `rowKey` was. */
    remember: (next: EntityFieldDefinition, rowKey: string) => { rowKeys.set(next, rowKey) },
    isNew: (f: EntityFieldDefinition) => fresh.has(keyOf(f)),
    add: (f: EntityFieldDefinition) => {
      const k = generateId('field')
      rowKeys.set(f, k)
      setFresh((s) => new Set(s).add(k))
    },
  }
}
export type FieldRows = ReturnType<typeof useFieldRows>

export function FieldsTab({ fields, setFields, readOnly, propertyKeys, rows, problems, relationship = false }: {
  fields: EntityFieldDefinition[]
  /** Change them, from the fields as they now are. */
  setFields: (update: (prev: EntityFieldDefinition[]) => EntityFieldDefinition[]) => void
  readOnly?: boolean
  /** Keys the type's entities (or relationships) carry, offered as a new field's property key. */
  propertyKeys: readonly string[]
  rows: FieldRows
  /** Why each field's key can't be saved, by index (`fieldKeyProblems`). */
  problems: ReadonlyArray<string | null>
  /** A relationship type's: no display, import-matching or uniqueness options (see the header). */
  relationship?: boolean
}) {
  const { keyOf, remember } = rows
  const [keyTouched, setKeyTouched] = useState<ReadonlySet<string>>(new Set())
  const listId = useId()

  const addField = () => {
    const newField: EntityFieldDefinition = {
      id: '',
      name: '',
      type: 'string',
      required: false,
      showInNode: false,
      showInPanel: true,
      showInTooltip: false,
      displayOrder: fields.length,
    }
    rows.add(newField)
    setFields((prev) => [...prev, newField])
  }

  const removeField = (rowKey: string) => {
    setFields((prev) => prev.filter((f) => keyOf(f) !== rowKey))
  }

  const updateField = (rowKey: string, updates: Partial<EntityFieldDefinition>) => {
    setFields((prev) => prev.map((f) => {
      if (keyOf(f) !== rowKey) return f
      const next = { ...f, ...updates }
      remember(next, rowKey)
      return next
    }))
  }
  const rename = (field: EntityFieldDefinition, name: string) => {
    const rowKey = keyOf(field)
    updateField(rowKey, rows.isNew(field) && !keyTouched.has(rowKey) ? { name, id: toPropertyKey(name) } : { name })
  }
  const setKey = (rowKey: string, id: string) => {
    setKeyTouched((s) => new Set(s).add(rowKey))
    updateField(rowKey, { id: id.trim() })
  }

  // Drag-reorder: rewrite displayOrder sequentially so persisted order matches.
  const reorderFields = (ordered: EntityFieldDefinition[]) => {
    setFields(() => ordered.map((f, i) => {
      const next = { ...f, displayOrder: i }
      remember(next, keyOf(f))
      return next
    }))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-bold text-ink-muted uppercase tracking-wider">Fields</h3>
          <p className="text-[10px] text-ink-muted/70 mt-0.5">{fields.length} field{fields.length !== 1 ? 's' : ''} defined</p>
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

      {propertyKeys.length > 0 && (
        <datalist id={listId}>
          {propertyKeys.map((k) => <option key={k} value={k} />)}
        </datalist>
      )}

      {fields.length === 0 ? (
        <div className="text-center py-8 rounded-xl border-2 border-dashed border-glass-border">
          <LucideIcons.List className="w-6 h-6 mx-auto mb-2 text-ink-muted/30" />
          <p className="text-xs text-ink-muted">No fields defined yet</p>
        </div>
      ) : (
        <Reorder.Group axis="y" values={fields} onReorder={reorderFields} className="space-y-2">
          {fields.map((field, index) => {
            const rowKey = keyOf(field)
            const editableKey = !readOnly && rows.isNew(field)
            const problem = problems[index]
            return (
            <Reorder.Item
              key={rowKey}
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
                  onChange={(e) => rename(field, e.target.value)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-transparent border border-transparent hover:border-glass-border focus:border-indigo-500/30 focus:bg-black/[0.02] dark:focus:bg-white/[0.02] text-sm font-medium text-ink placeholder:text-ink-muted/50 focus:outline-none transition-all"
                  placeholder="Field name"
                  aria-label="Field name"
                  disabled={readOnly}
                />

                <select
                  value={field.type}
                  onChange={(e) => updateField(rowKey, { type: e.target.value as EntityFieldDefinition['type'] })}
                  aria-label="Field type"
                  className="px-2 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-xs text-ink-secondary font-medium focus:outline-none focus:ring-1 focus:ring-indigo-500/30 cursor-pointer"
                  disabled={readOnly}
                >
                  {/* A type the list doesn't offer is kept as it is stored. */}
                  {!FIELD_TYPE_OPTIONS.some((o) => o.value === field.type) && <option value={field.type}>{String(field.type)}</option>}
                  {FIELD_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                {!readOnly && (
                  <button
                    onClick={() => removeField(rowKey)}
                    aria-label={`Remove ${field.name || 'field'}`}
                    className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 text-ink-muted/40 hover:text-red-500 transition-colors flex-shrink-0"
                  >
                    <LucideIcons.Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* The property it is: a new field's key follows its name until typed; a saved one's is fixed. */}
              <div className="flex items-center gap-2 px-3 pb-2 -mt-1">
                <HoverTip label="Property key" detail="The property this field reads and writes on each entity — fixed once saved, since entities hold their values under it" className="inline-flex shrink-0">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80">Key</span>
                </HoverTip>
                {editableKey ? (
                  <input
                    type="text"
                    value={field.id}
                    onChange={(e) => setKey(rowKey, e.target.value)}
                    list={propertyKeys.length > 0 ? listId : undefined}
                    aria-label="Property key"
                    aria-invalid={problem ? true : undefined}
                    placeholder="property_key"
                    className={cn('flex-1 min-w-0 px-2 py-1 rounded-md bg-black/[0.02] dark:bg-white/[0.03] border text-[11px] font-mono text-ink placeholder:text-ink-muted/50 focus:outline-none',
                      problem ? 'border-rose-500/50' : 'border-glass-border focus:border-indigo-500/30')}
                  />
                ) : (
                  <code className="min-w-0 truncate text-[11px] font-mono text-ink-secondary">{field.id}</code>
                )}
              </div>
              {problem && !readOnly && <p role="alert" className="px-3 pb-2 -mt-1 text-[10px] text-rose-600 dark:text-rose-400">{problem}</p>}

              {/* Field options row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 bg-black/[0.015] dark:bg-white/[0.015] border-t border-glass-border/50">
                {(relationship ? [] : [
                  { key: 'showInNode' as const, label: 'Node' },
                  { key: 'showInPanel' as const, label: 'Panel' },
                  { key: 'showInTooltip' as const, label: 'Tooltip' },
                ] as const).map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-1 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={field[key]}
                      onChange={(e) => updateField(rowKey, { [key]: e.target.checked })}
                      className="w-3 h-3 rounded accent-indigo-500"
                      disabled={readOnly}
                    />
                    <span className="text-[10px] text-ink-muted font-medium">{label}</span>
                  </label>
                ))}
                {/* What an import and a publish do with the field — said where it is set. */}
                {([
                  { key: 'required' as const, label: 'Required',
                    tip: `Every ${relationship ? 'relationship' : 'entity'} of this type needs a value here — a draft that adds one without it, or empties it, can’t be published` },
                  ...(relationship ? [] : [
                    { key: 'reconciliationKey' as const, label: 'Match imports by this',
                      tip: 'An import updates the entity with the same value here, instead of adding another' },
                    { key: 'unique' as const, label: 'Must be unique',
                      tip: 'No two entities of this type can share a value here — a draft that does can’t be published' },
                  ]),
                ]).map(({ key, label, tip }) => (
                  <HoverTip key={key} label={tip}>
                    <label className="flex items-center gap-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={field[key] ?? false}
                        onChange={(e) => updateField(rowKey, { [key]: e.target.checked })}
                        className="w-3 h-3 rounded accent-indigo-500"
                        disabled={readOnly}
                      />
                      <span className="text-[10px] text-ink-muted font-medium">{label}</span>
                    </label>
                  </HoverTip>
                ))}
              </div>

              {/* The values it may hold — none: any. */}
              <div className="px-3 py-2 border-t border-glass-border/50">
                <AllowedValuesEditor
                  label={`Allowed values of ${field.name || field.id || 'this field'}`}
                  values={field.allowedValues ?? []}
                  allowOther={field.allowOther ?? false}
                  disabled={readOnly}
                  onChange={(values, allowOther) => updateField(rowKey, {
                    allowedValues: values.length ? values : undefined,
                    allowOther: values.length && allowOther ? true : undefined,
                  })}
                />
              </div>
            </Reorder.Item>
            )
          })}
        </Reorder.Group>
      )}
    </div>
  )
}
