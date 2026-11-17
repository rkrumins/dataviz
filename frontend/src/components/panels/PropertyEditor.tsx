/**
 * PropertyEditor — recursive CRUD editor for arbitrary JSON values.
 *
 * Drives the nested-property editing surface inside EntityDrawer's View and
 * Edit modes. Pure controlled component: parent owns the value, this component
 * emits a new deep-cloned value on every mutation so referential equality
 * checks in staging stores see a real change.
 *
 * Layout: every row uses the same two-column grid (key | value) regardless of
 * value type or length, so rows align consistently. Long string values clamp
 * to a few lines and can be opened in a Markdown editor/preview modal.
 *
 * Inline mode (`inline`): rows read like View mode, and each value is edited
 * where it is shown — click it, type, Enter (or click away) keeps it, Esc puts
 * it back. Given the properties as first read (`original`), each row says
 * what its edit did: New, Edited (with what it was, and Revert) or Removed
 * (with Restore).
 */

import { useState, useCallback, useMemo, useRef, useEffect, memo, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { Backdrop } from '@/components/ui/Backdrop'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Lock,
  GripVertical,
  Code,
  Check,
  X as XIcon,
  Search,
  Maximize2,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  Undo2,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { HighlightedText } from '@/components/ui/HighlightedText'
import { HoverTip } from '@/components/ui/HoverTip'
import { fieldTone } from '@/features/versioning/model/changeTone'
import {
  type FieldType,
  FIELD_TYPE_META,
  COMMON_TYPES,
  ADVANCED_TYPES,
  inferFieldType,
  valueForType,
  coerceToType,
} from './property/fieldTypes'
import {
  BooleanToggle,
  DateField,
  UrlField,
  TagInput,
  ClampedText,
  FormattedDate,
  FormattedLink,
  FormattedTags,
} from './property/valueWidgets'
import { MarkdownValueModal } from './property/MarkdownValueEditor'
import { InlineValue } from './property/InlineValue'
import { propertyMarks, shortValue, type ChangeMark, type PropertyMarks } from './property/changeMarks'

// ============================================
// Types
// ============================================

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

/** In read-only (View) mode, whether string values render as formatted Markdown
 *  or as raw source. Irrelevant in edit mode (values are editable inputs). */
type DisplayMode = 'formatted' | 'source'
const DisplayModeContext = createContext<DisplayMode>('source')

/** In Edit mode, whether text values are edited as rich WYSIWYG (default) or as
 *  raw Markdown source. */
type EditTextMode = 'rich' | 'source'
const EditTextModeContext = createContext<EditTextMode>('rich')

/** Values are edited where they are read (see the header). */
const InlineModeContext = createContext(false)

export interface PropertyEditorProps {
  value: unknown
  onChange: (next: unknown) => void
  /** Keys at the root level rendered with a lock icon, no edit/delete affordances. */
  readOnlyKeys?: string[]
  /** Hide the outer card chrome — useful when embedded directly in a parent section. */
  bare?: boolean
  /** Render every value/key as non-editable. Navigation (expand/collapse,
   *  search, copy, open-in-modal-to-read) still works. Used in View mode. */
  readOnly?: boolean
  /** Show a search box at the root that filters top-level entries by key/value. */
  searchable?: boolean
  /** Treat '/' in top-level keys as a folder path and render an expandable tree
   *  (e.g. "Technical/Physical Path" → folder "Technical" → leaf "Physical Path").
   *  Pure presentation: the stored object stays a flat string→value map. */
  groupByPath?: boolean
  /** Edit each value in place, as it reads (see the header). Ignored with `readOnly`. */
  inline?: boolean
  /** The properties as first read: each row then says New / Edited / Removed. Root objects only. */
  original?: Record<string, unknown>
  /** Open the add-property form straight away (an empty entity's "Add properties"). */
  startAdding?: boolean
  /** Property names worth adding, offered as one-click starts next to "Add property". */
  suggestions?: string[]
}

const MAX_DEPTH = 6
/** Separator that turns a flat key into a folder path. */
const PATH_SEP = '/'

// ============================================
// Helpers
// ============================================

function kindOf(v: unknown): ValueKind {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v as ValueKind
}

/** Flat, lowercase text used to test a row against the search query. */
function searchableText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    try { return JSON.stringify(value).toLowerCase() } catch { return '' }
  }
  return String(value).toLowerCase()
}

// ============================================
// Root
// ============================================

export function PropertyEditor({
  value,
  onChange,
  readOnlyKeys,
  bare,
  readOnly,
  searchable,
  groupByPath,
  inline,
  original,
  startAdding,
  suggestions,
}: PropertyEditorProps) {
  return (
    <InlineModeContext.Provider value={!!inline && !readOnly}>
      <PropertyEditorRoot value={value} onChange={onChange} readOnlyKeys={readOnlyKeys} bare={bare} readOnly={readOnly}
        searchable={searchable} groupByPath={groupByPath} original={original} startAdding={startAdding} suggestions={suggestions} />
    </InlineModeContext.Provider>
  )
}

function PropertyEditorRoot({
  value,
  onChange,
  readOnlyKeys,
  bare,
  readOnly,
  searchable,
  groupByPath,
  original,
  startAdding,
  suggestions,
}: Omit<PropertyEditorProps, 'inline'>) {
  const rootKind = kindOf(value)

  // If the root isn't an object/array, render a single value editor.
  // In practice we always pass an object from EntityDrawer, but keep this safe.
  if (rootKind !== 'object' && rootKind !== 'array') {
    return <PrimitiveValueEditor value={value} onChange={onChange} readOnly={readOnly} />
  }

  if (rootKind === 'object' && groupByPath) {
    return (
      <GroupedObjectRoot
        value={value as Record<string, unknown>}
        onChange={onChange as (v: Record<string, unknown>) => void}
        readOnlyKeys={readOnlyKeys}
        readOnly={readOnly}
        searchable={searchable}
        original={original}
        startAdding={startAdding}
        suggestions={suggestions}
      />
    )
  }

  if (rootKind === 'array') {
    return (
      <ArrayBody
        value={value as unknown[]}
        onChange={onChange as (v: unknown[]) => void}
        depth={0}
        bare={bare}
        readOnly={readOnly}
        searchable={searchable}
      />
    )
  }

  return (
    <ObjectBody
      value={value as Record<string, unknown>}
      onChange={onChange as (v: Record<string, unknown>) => void}
      readOnlyKeys={readOnlyKeys}
      depth={0}
      bare={bare}
      readOnly={readOnly}
      searchable={searchable}
    />
  )
}

// ============================================
// SearchBox — root-level key/value filter
// ============================================

function SearchBox({
  query,
  onChange,
  placeholder,
}: {
  query: string
  onChange: (q: string) => void
  placeholder: string
}) {
  return (
    <div className="relative mb-2">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
      <input
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full pl-8 pr-7 py-1.5 rounded-lg bg-black/[0.03] dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs",
          "focus:border-accent-lineage/50 outline-none transition-colors",
        )}
      />
      {query && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-ink-muted hover:text-ink"
          title="Clear search"
        >
          <XIcon className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

// ============================================
// Object Body
// ============================================

interface ObjectBodyProps {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  readOnlyKeys?: string[]
  depth: number
  bare?: boolean
  readOnly?: boolean
  searchable?: boolean
  /** When provided, filter by this query instead of rendering an own SearchBox.
   *  Used by GroupedObjectRoot's Flat view so one search box drives both modes. */
  externalQuery?: string
  /** What each key's edit did (root only — see `propertyMarks`), and putting one back. */
  marks?: PropertyMarks['marks']
  onRevert?: (key: string) => void
}

function ObjectBody({ value, onChange, readOnlyKeys, depth, bare, readOnly, searchable, externalQuery, marks, onRevert }: ObjectBodyProps) {
  const [adding, setAdding] = useState(false)
  const [ownQuery, setOwnQuery] = useState('')
  const usesExternalQuery = externalQuery !== undefined
  const isSearchRoot = depth === 0 && !!searchable && !usesExternalQuery
  const query = usesExternalQuery ? externalQuery! : ownQuery
  const setQuery = setOwnQuery
  const entries = Object.entries(value)

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(([k, v]) => k.toLowerCase().includes(q) || searchableText(v).includes(q))
  }, [entries, query])

  const updateKey = useCallback((oldKey: string, newKey: string) => {
    if (oldKey === newKey || !newKey.trim()) return
    if (Object.prototype.hasOwnProperty.call(value, newKey)) return
    // Preserve insertion order: rebuild object swapping the key in place.
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      next[k === oldKey ? newKey : k] = v
    }
    onChange(next)
  }, [value, onChange])

  const updateValue = useCallback((key: string, newValue: unknown) => {
    onChange({ ...value, [key]: newValue })
  }, [value, onChange])

  const deleteKey = useCallback((key: string) => {
    const { [key]: _removed, ...rest } = value
    onChange(rest)
  }, [value, onChange])

  const addKey = useCallback((key: string, newValue: unknown) => {
    if (!key.trim()) return
    if (Object.prototype.hasOwnProperty.call(value, key)) return
    onChange({ ...value, [key]: newValue })
    setAdding(false)
  }, [value, onChange])

  // Empty object: in read-only mode show a muted placeholder; in edit mode
  // offer the add affordance.
  if (entries.length === 0 && !adding) {
    if (readOnly) {
      return <div className="text-xs text-ink-muted italic px-2 py-2">No properties</div>
    }
    return (
      <div className={cn(!bare && "rounded-lg border border-glass-border/40 bg-black/5 dark:bg-white/[0.02] px-3 py-3")}>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add first property
        </button>
      </div>
    )
  }

  return (
    <div className={cn(depth > 0 && "pl-3 border-l border-glass-border/40 ml-1.5")}>
      {isSearchRoot && (
        <SearchBox
          query={query}
          onChange={setQuery}
          placeholder={`Search ${entries.length} ${entries.length === 1 ? 'property' : 'properties'}…`}
        />
      )}
      <div className="space-y-1">
        {filteredEntries.map(([key, v]) => (
          <PropertyRow
            key={key}
            rowKey={key}
            value={v}
            readOnly={readOnly || (depth === 0 && readOnlyKeys?.includes(key))}
            depth={depth}
            query={isSearchRoot ? query : ''}
            onKeyChange={(nk) => updateKey(key, nk)}
            onValueChange={(nv) => updateValue(key, nv)}
            onDelete={() => deleteKey(key)}
            mark={marks?.get(key)?.mark}
            was={marks?.get(key)?.was}
            onRevert={onRevert && marks?.has(key) ? () => onRevert(key) : undefined}
          />
        ))}
        {(isSearchRoot || usesExternalQuery) && query.trim() && filteredEntries.length === 0 && (
          <div className="text-xs text-ink-muted px-2 py-3">
            No properties match “{query.trim()}”.
          </div>
        )}
      </div>
      {!readOnly && (
        adding ? (
          <PropertyComposer
            onAdd={addKey}
            onCancel={() => setAdding(false)}
            existingKeys={Object.keys(value)}
            variant="object"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors mt-1.5 ml-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Add property
          </button>
        )
      )}
    </div>
  )
}

// ============================================
// Array Body
// ============================================

interface ArrayBodyProps {
  value: unknown[]
  onChange: (next: unknown[]) => void
  depth: number
  bare?: boolean
  readOnly?: boolean
  searchable?: boolean
}

function ArrayBody({ value, onChange, depth, bare, readOnly, searchable }: ArrayBodyProps) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const isSearchRoot = depth === 0 && !!searchable

  // Reorder.Group needs stable item identities — we use string keys derived from
  // index. To keep DnD stable, attach an index-based key.
  const keyedItems = useMemo(
    () => value.map((v, i) => ({ id: `${i}`, value: v, index: i })),
    [value],
  )

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return keyedItems
    return keyedItems.filter((item) => searchableText(item.value).includes(q))
  }, [keyedItems, query])

  const updateAt = useCallback((index: number, newValue: unknown) => {
    const next = value.slice()
    next[index] = newValue
    onChange(next)
  }, [value, onChange])

  const deleteAt = useCallback((index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }, [value, onChange])

  const addItem = useCallback((_key: string, newValue: unknown) => {
    onChange([...value, newValue])
    setAdding(false)
  }, [value, onChange])

  const handleReorder = useCallback((items: typeof keyedItems) => {
    onChange(items.map(item => item.value))
  }, [onChange])

  if (value.length === 0 && !adding) {
    if (readOnly) {
      return <div className="text-xs text-ink-muted italic px-2 py-2">No items</div>
    }
    return (
      <div className={cn(!bare && "rounded-lg border border-glass-border/40 bg-black/5 dark:bg-white/[0.02] px-3 py-3")}>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add first item
        </button>
      </div>
    )
  }

  // While searching or in read-only mode, drag-reorder is disabled — render a
  // plain list so the displayed order matches the source array.
  const canReorder = !readOnly && !(isSearchRoot && query.trim())

  return (
    <div className={cn(depth > 0 && "pl-3 border-l border-glass-border/40 ml-1.5")}>
      {isSearchRoot && (
        <SearchBox
          query={query}
          onChange={setQuery}
          placeholder={`Search ${value.length} ${value.length === 1 ? 'item' : 'items'}…`}
        />
      )}
      {canReorder ? (
        <Reorder.Group axis="y" values={keyedItems} onReorder={handleReorder} className="space-y-1">
          {keyedItems.map((item) => (
            <Reorder.Item key={item.id} value={item} className="list-none">
              <PropertyRow
                rowKey={`[${item.index}]`}
                value={item.value}
                depth={depth}
                isArrayItem
                onValueChange={(nv) => updateAt(item.index, nv)}
                onDelete={() => deleteAt(item.index)}
              />
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <div className="space-y-1">
          {visibleItems.map((item) => (
            <PropertyRow
              key={item.id}
              rowKey={`[${item.index}]`}
              value={item.value}
              depth={depth}
              isArrayItem
              readOnly={readOnly}
              query={isSearchRoot ? query : ''}
              onValueChange={(nv) => updateAt(item.index, nv)}
              onDelete={() => deleteAt(item.index)}
            />
          ))}
          {isSearchRoot && query.trim() && visibleItems.length === 0 && (
            <div className="text-xs text-ink-muted px-2 py-3">
              No items match “{query.trim()}”.
            </div>
          )}
        </div>
      )}
      {!readOnly && (
        adding ? (
          <PropertyComposer
            onAdd={addItem}
            onCancel={() => setAdding(false)}
            existingKeys={[]}
            variant="array"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors mt-1.5 ml-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Add item
          </button>
        )
      )}
    </div>
  )
}

// ============================================
// PropertyRow — single key/value row, renders the right body for its kind
// ============================================

interface PropertyRowProps {
  rowKey: string
  value: unknown
  readOnly?: boolean
  isArrayItem?: boolean
  depth: number
  query?: string
  onKeyChange?: (newKey: string) => void
  onValueChange: (newValue: unknown) => void
  onDelete: () => void
  /** What this row's edit did, since the entity was read. */
  mark?: ChangeMark
  /** The value as read, for an edited row. */
  was?: unknown
  /** Put the row back as it was read. */
  onRevert?: () => void
}

/** The row's left edge and badge for what its edit did. */
const MARK_STYLE: Record<ChangeMark, { bar: string; badge: string; label: string }> = {
  // The tree's colours (`changeTone`): green for new, orange for edited.
  new: { bar: 'before:bg-green-500', badge: fieldTone('added').chip, label: 'New' },
  changed: { bar: 'before:bg-orange-500', badge: fieldTone('changed').chip, label: 'Edited' },
}

const PropertyRow = memo(function PropertyRow({
  rowKey,
  value,
  readOnly,
  isArrayItem,
  depth,
  query = '',
  onKeyChange,
  onValueChange,
  onDelete,
  mark,
  was,
  onRevert,
}: PropertyRowProps) {
  const inline = useContext(InlineModeContext)
  const fieldType = inferFieldType(value)
  const isContainer = fieldType === 'group' || fieldType === 'list'
  const [expanded, setExpanded] = useState(depth < 1)
  const [editingKey, setEditingKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState(rowKey)
  const [rawJsonOpen, setRawJsonOpen] = useState(false)

  useEffect(() => { setKeyDraft(rowKey) }, [rowKey])

  // Esc puts the name back: the blur that follows (the input leaving) must not rename it after all.
  const keyCancelled = useRef(false)
  const commitKey = () => {
    if (keyCancelled.current) { keyCancelled.current = false; return }
    setEditingKey(false)
    if (keyDraft !== rowKey && keyDraft.trim()) {
      onKeyChange?.(keyDraft.trim())
    } else {
      setKeyDraft(rowKey)
    }
  }

  const changeType = (next: FieldType) => {
    onValueChange(coerceToType(value, next))
  }

  return (
    <div className="group">
      <div className={cn(
        "relative flex items-start gap-1.5 py-1.5 px-1 rounded-lg",
        "hover:bg-black/[0.025] dark:hover:bg-white/[0.03] transition-colors",
        mark && cn("before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full", MARK_STYLE[mark].bar),
      )}>
        {/* Expand / drag handle */}
        <div className="flex items-center h-6 w-4 flex-shrink-0">
          {isContainer ? (
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-4 h-5 flex items-center justify-center text-ink-muted hover:text-ink"
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : isArrayItem && !readOnly ? (
            <GripVertical className="w-3.5 h-3.5 text-ink-muted/40 cursor-grab" />
          ) : (
            <span className="w-4" />
          )}
        </div>

        {/* Key column — fixed basis so rows align consistently */}
        <div className="basis-[132px] flex-shrink-0 min-w-0 h-6 flex items-center">
          {isArrayItem ? (
            <span className="text-xs font-mono text-ink-muted truncate">{rowKey}</span>
          ) : readOnly ? (
            <span className="flex items-center gap-1.5 text-xs font-mono text-ink-muted truncate" title={rowKey}>
              <Lock className="w-3 h-3 flex-shrink-0" />
              <HighlightedText text={rowKey} query={query} className="truncate" />
            </span>
          ) : editingKey ? (
            <input
              autoFocus
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={commitKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitKey()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  keyCancelled.current = true
                  setKeyDraft(rowKey)
                  setEditingKey(false)
                }
              }}
              className="text-xs font-mono px-1.5 py-0.5 rounded bg-black/[0.06] dark:bg-white/10 border border-accent-lineage/40 outline-none min-w-0 w-full"
            />
          ) : (
            <button
              onClick={() => { keyCancelled.current = false; setEditingKey(true) }}
              className="text-xs font-mono text-ink hover:text-accent-lineage truncate text-left max-w-full"
              title={`${rowKey} — click to rename`}
            >
              <HighlightedText text={rowKey} query={query} />
            </button>
          )}
          {mark && (
            <HoverTip
              label={mark === 'new' ? 'Added since it was read' : `Was: ${shortValue(was)}`}
              detail="Staged — saved with Review & Save"
              className="inline-flex flex-shrink-0 ml-1.5"
            >
              <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide', MARK_STYLE[mark].badge)}>
                {MARK_STYLE[mark].label}
              </span>
            </HoverTip>
          )}
        </div>

        {/* Value column — flexible, consistent across all kinds */}
        <div className="flex-1 min-w-0">
          {isContainer ? (
            <span className="text-2xs text-ink-muted h-6 flex items-center">
              {fieldType === 'group'
                ? `${Object.keys(value as object).length} ${Object.keys(value as object).length === 1 ? 'key' : 'keys'}`
                : `${(value as unknown[]).length} ${(value as unknown[]).length === 1 ? 'item' : 'items'}`}
            </span>
          ) : (
            <PrimitiveValueEditor
              value={value}
              onChange={onValueChange}
              readOnly={readOnly}
              query={query}
              fieldLabel={rowKey}
            />
          )}
        </div>

        {/* Inline, the row reads as a value: its type and actions float over its end when you
            reach for it (taking no width, so values don't wrap for them), and step aside while a
            value is being edited. */}
        <div className={cn(
          'flex items-center gap-1.5 flex-shrink-0',
          inline && !readOnly && cn(
            'absolute right-1 top-1 z-10 h-7 px-1 gap-0.5 rounded-lg bg-canvas-elevated border border-black/10 dark:border-white/10 shadow-sm',
            'opacity-0 pointer-events-none transition-opacity',
            'group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
            'group-has-[[data-inline-editing]]:hidden',
          ),
        )}>
        {/* Type control — icon-only on the right (edit only); in read-only the
            formatted value already conveys the type, so the chip is omitted to
            keep the focus on the property name + value. */}
        {!readOnly && (
          <div className="h-6 flex items-center flex-shrink-0">
            <FieldTypeChip fieldType={fieldType} onChange={changeType} showLabel={false} />
          </div>
        )}

        {/* Row actions */}
        <div className={cn(
          "flex items-center gap-0.5 flex-shrink-0 h-6",
          !inline && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity",
        )}>
          {isContainer && !readOnly && depth < MAX_DEPTH - 1 && (
            <button
              onClick={() => setRawJsonOpen(true)}
              className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10"
              title="Edit as raw JSON"
            >
              <Code className="w-3 h-3" />
            </button>
          )}
          {!readOnly && onRevert && (
            <HoverTip label={mark === 'new' ? 'Remove this new property' : 'Revert to what it was'} detail={mark === 'changed' ? `Was: ${shortValue(was)}` : undefined} className="inline-flex">
              <button
                onClick={onRevert}
                aria-label={`Revert ${rowKey}`}
                className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10"
              >
                <Undo2 className="w-3 h-3" />
              </button>
            </HoverTip>
          )}
          {!readOnly && (
            <HoverTip label={`Delete ${rowKey}`} detail="It stays listed, struck through, until you save — Restore brings it back." className="inline-flex">
              <button
                onClick={onDelete}
                aria-label={`Delete ${rowKey}`}
                className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-rose-500 hover:bg-rose-500/10"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </HoverTip>
          )}
        </div>
        </div>
      </div>

      {/* Container body */}
      {isContainer && expanded && depth < MAX_DEPTH - 1 && (
        <div className="ml-5 mb-1">
          {fieldType === 'group' ? (
            <ObjectBody
              value={value as Record<string, unknown>}
              onChange={onValueChange as (v: Record<string, unknown>) => void}
              depth={depth + 1}
              readOnly={readOnly}
            />
          ) : (
            <ArrayBody
              value={value as unknown[]}
              onChange={onValueChange as (v: unknown[]) => void}
              depth={depth + 1}
              readOnly={readOnly}
            />
          )}
        </div>
      )}

      {/* Raw-JSON fallback at max depth (always shown when expanded) */}
      {isContainer && expanded && depth >= MAX_DEPTH - 1 && (
        <div className="ml-5 mb-1">
          <RawJsonEditor
            value={value}
            onChange={onValueChange}
            isOpen={true}
            onClose={() => setRawJsonOpen(false)}
            readOnly={readOnly}
            inline
          />
        </div>
      )}

      {/* Modal raw-JSON editor (opened from the Code action on any container) */}
      {rawJsonOpen && depth < MAX_DEPTH - 1 && (
        <RawJsonEditor
          value={value}
          onChange={onValueChange}
          isOpen={rawJsonOpen}
          onClose={() => setRawJsonOpen(false)}
          readOnly={readOnly}
        />
      )}
    </div>
  )
})

// ============================================
// PrimitiveValueEditor — consistent full-width value cell per kind
// ============================================

function PrimitiveValueEditor({
  value,
  onChange,
  readOnly,
  query = '',
  fieldLabel,
}: {
  value: unknown
  onChange: (next: unknown) => void
  readOnly?: boolean
  query?: string
  fieldLabel?: string
}) {
  const display = useContext(DisplayModeContext)
  const editTextMode = useContext(EditTextModeContext)
  const inline = useContext(InlineModeContext)
  const fieldType = inferFieldType(value)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMaximized, setModalMaximized] = useState(false)

  // Stable handler so memoized ClampedText doesn't re-render on every parent render.
  const openModal = useCallback((maximized?: boolean) => {
    setModalMaximized(!!maximized)
    setModalOpen(true)
  }, [])

  const expandButton = (
    <button
      onClick={() => openModal(false)}
      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-muted/70 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
      title={readOnly ? 'View full value' : 'Open editor (Markdown)'}
    >
      <Maximize2 className="w-3 h-3" />
    </button>
  )

  // ---------------------------------------------------------------- inline
  // Reads as View mode; a click edits it where it is (property/InlineValue).
  if (inline && !readOnly) {
    return (
      <InlineValue
        value={value}
        fieldType={fieldType}
        fieldLabel={fieldLabel}
        onCommit={onChange}
        readView={<PrimitiveValueEditor value={value} onChange={onChange} readOnly query={query} fieldLabel={fieldLabel} />}
      />
    )
  }

  // ---------------------------------------------------------------- read-only
  if (readOnly) {
    if (fieldType === 'none') {
      return <span className="text-xs text-ink-muted italic h-6 flex items-center">—</span>
    }
    if (fieldType === 'boolean') {
      return <div className="h-6 flex items-center"><BooleanToggle value={Boolean(value)} onChange={() => {}} readOnly /></div>
    }
    if (fieldType === 'number') {
      return <span className="text-xs font-mono text-ink h-6 flex items-center"><HighlightedText text={String(value)} query={query} /></span>
    }
    if (fieldType === 'tags') {
      return display === 'source'
        ? <span className="text-xs font-mono text-ink-muted break-all">{JSON.stringify(value)}</span>
        : <FormattedTags value={value as string[]} />
    }
    // text / date / url — all stored as strings
    const s = value === null || value === undefined ? '' : String(value)
    let body: React.ReactNode
    if (display === 'source') {
      body = (
        <div className="text-xs font-mono text-ink whitespace-pre-wrap break-words">
          {s === '' ? <span className="italic text-ink-muted">empty</span> : <HighlightedText text={s} query={query} />}
        </div>
      )
    } else if (fieldType === 'date') {
      body = <FormattedDate value={s} />
    } else if (fieldType === 'url') {
      body = <FormattedLink value={s} />
    } else {
      // formatted text — clamp; Expand grows in-drawer, Full screen → modal viewer
      body = <ClampedText text={s} onOpen={openModal} />
    }
    return (
      <>
        <div className="flex items-start gap-1">
          <div className="flex-1 min-w-0">{body}</div>
          <div className="flex items-start">
            {s !== '' && <CopyButton text={s} />}
            {fieldType === 'text' && expandButton}
          </div>
        </div>
        {modalOpen && (
          <MarkdownValueModal fieldLabel={fieldLabel} value={s} readOnly initialMaximized={modalMaximized} onSave={() => setModalOpen(false)} onClose={() => setModalOpen(false)} />
        )}
      </>
    )
  }

  // ---------------------------------------------------------------- editable
  if (fieldType === 'none') {
    return <span className="text-xs text-ink-muted italic h-6 flex items-center">empty</span>
  }
  if (fieldType === 'boolean') {
    return <div className="h-6 flex items-center"><BooleanToggle value={Boolean(value)} onChange={onChange} /></div>
  }
  if (fieldType === 'number') {
    return (
      <input
        type="number"
        value={value as number}
        onChange={(e) => { const n = Number(e.target.value); onChange(Number.isFinite(n) ? n : 0) }}
        className={cn(
          "w-full px-2 py-1 rounded-md bg-black/[0.03] dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs font-mono",
          "focus:border-accent-lineage/50 focus:bg-white/8 outline-none transition-colors",
        )}
      />
    )
  }
  if (fieldType === 'date') {
    return <DateField value={value === null || value === undefined ? '' : String(value)} onChange={onChange} />
  }
  if (fieldType === 'url') {
    return <UrlField value={value === null || value === undefined ? '' : String(value)} onChange={onChange} />
  }
  if (fieldType === 'tags') {
    return <TagInput value={value as string[]} onChange={onChange} />
  }

  // text — click-to-edit: the cell is a clamped preview; the rich editor lives
  // in the modal (no per-row editors → the list stays snappy).
  const stringValue = value === null || value === undefined ? '' : String(value)
  return (
    <>
      <div className="flex items-start gap-1">
        <div className="flex-1 min-w-0">
          <ClampedText
            text={stringValue}
            source={editTextMode === 'source'}
            editable
            onOpen={openModal}
          />
        </div>
        <div className="flex items-start">
          {stringValue !== '' && <CopyButton text={stringValue} />}
          {expandButton}
        </div>
      </div>
      {modalOpen && (
        <MarkdownValueModal
          fieldLabel={fieldLabel}
          value={stringValue}
          initialMode={editTextMode}
          initialMaximized={modalMaximized}
          onSave={(next) => { onChange(next); setModalOpen(false) }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}

// ============================================
// CopyButton — small hover-revealed copy affordance
// ============================================

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard unavailable */ }
      }}
      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
      title={copied ? 'Copied!' : 'Copy value'}
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

function ModalTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
        active ? "bg-black/[0.06] dark:bg-white/10 text-ink" : "text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5",
      )}
    >
      {label}
    </button>
  )
}

// ============================================
// FieldTypeChip — friendly, business-facing type label + change menu
// ============================================

function FieldTypeChip({
  fieldType,
  readOnly,
  onChange,
  showLabel = true,
}: {
  fieldType: FieldType
  readOnly?: boolean
  onChange?: (next: FieldType) => void
  showLabel?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const meta = FIELD_TYPE_META[fieldType]
  const Icon = meta.icon

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const renderOption = (t: FieldType) => {
    const m = FIELD_TYPE_META[t]
    const MIcon = m.icon
    return (
      <button
        key={t}
        onClick={() => { onChange?.(t); setOpen(false) }}
        className={cn(
          "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-xs hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors text-left",
          fieldType === t && "bg-black/[0.03] dark:bg-white/5",
        )}
      >
        <MIcon className={cn("w-3.5 h-3.5 flex-shrink-0", m.tone.split(' ')[0])} />
        <span className="flex-1 min-w-0">
          <span className="text-ink">{m.label}</span>
          <span className="block text-2xs text-ink-muted truncate">{m.hint}</span>
        </span>
        {fieldType === t && <Check className="w-3 h-3 text-accent-lineage flex-shrink-0" />}
      </button>
    )
  }

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => !readOnly && onChange && setOpen((o) => !o)}
        disabled={readOnly || !onChange}
        className={cn(
          "h-5 px-1.5 rounded-md text-2xs font-medium flex items-center gap-1",
          meta.tone,
          (readOnly || !onChange) ? "cursor-default" : "hover:brightness-125",
        )}
        title={readOnly ? meta.label : 'Change type'}
      >
        <Icon className="w-3 h-3" />
        {showLabel && meta.label}
      </button>
      {open && onChange && (
        <div className="absolute left-0 top-7 z-50 min-w-[200px] rounded-lg border border-glass-border bg-canvas-elevated shadow-lg p-1">
          {COMMON_TYPES.map(renderOption)}
          <div className="my-1 px-2 text-2xs uppercase tracking-wider text-ink-muted/70">Advanced</div>
          {ADVANCED_TYPES.map(renderOption)}
        </div>
      )}
    </div>
  )
}

// ============================================
// PropertyComposer — guided add: key + type + value in one step
// ============================================

function PropertyComposer({
  onAdd,
  onCancel,
  existingKeys,
  variant,
  prefixLabel,
  initialKey = '',
}: {
  /** key is '' for array items; value is the fully-formed value to insert. */
  onAdd: (key: string, value: unknown) => void
  onCancel: () => void
  existingKeys: string[]
  variant: 'object' | 'array'
  /** Read-only path chip shown before the key input (folder-scoped add). */
  prefixLabel?: string
  /** The name to start with (a suggestion). */
  initialKey?: string
}) {
  const [key, setKey] = useState(initialKey)
  const [type, setType] = useState<FieldType>('text')
  const [draft, setDraft] = useState<unknown>('')
  const [modalOpen, setModalOpen] = useState(false)

  const candidateKey = prefixLabel ? `${prefixLabel}/${key.trim()}` : key.trim()
  const isDup = variant === 'object' && key.trim() !== '' && existingKeys.includes(candidateKey)
  const canSubmit = variant === 'array' || (key.trim() !== '' && !isDup)

  const changeType = (t: FieldType) => {
    setType(t)
    setDraft(valueForType(t))
  }

  const submit = () => {
    if (!canSubmit) return
    onAdd(variant === 'array' ? '' : key.trim(), draft)
  }

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
  }

  return (
    <div
      onKeyDown={onFormKeyDown}
      className="mt-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-accent-lineage/30 p-3 space-y-2.5 shadow-sm"
    >
      {/* Row 1: name + type */}
      <div className="flex items-center gap-2">
        {prefixLabel && (
          <span
            className="text-2xs font-mono text-ink-muted bg-black/[0.03] dark:bg-white/5 rounded px-1.5 py-0.5 max-w-[140px] truncate flex-shrink-0"
            title={prefixLabel}
          >
            {prefixLabel}/
          </span>
        )}
        {variant === 'object' ? (
          <input
            autoFocus
            value={key}
            placeholder="Property name"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            className={cn(
              "flex-1 min-w-0 text-sm px-2.5 py-1.5 rounded-md bg-black/[0.03] dark:bg-white/5 border outline-none",
              isDup ? "border-red-500/40" : "border-black/10 dark:border-white/10 focus:border-accent-lineage/50",
            )}
          />
        ) : (
          <span className="flex-1 text-xs text-ink-muted">New {FIELD_TYPE_META[type].label} item</span>
        )}
        <FieldTypeChip fieldType={type} onChange={changeType} />
      </div>

      {isDup && (
        <p className="text-2xs text-red-500 pl-1">“{candidateKey}” already exists.</p>
      )}

      {/* Row 2: value (adapts to the chosen type) */}
      <div className="flex items-center gap-2">
        <span className="text-2xs uppercase tracking-wider text-ink-muted w-10 flex-shrink-0">Value</span>
        <div className="flex-1 min-w-0">
          <ComposerValueField
            type={type}
            value={draft}
            onChange={setDraft}
            onExpand={() => setModalOpen(true)}
            onEnter={submit}
          />
        </div>
      </div>

      {/* Row 3: actions */}
      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className={cn(
            "flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all",
            canSubmit
              ? "bg-accent-lineage text-white hover:brightness-110 shadow-sm shadow-accent-lineage/25"
              : "bg-black/[0.03] dark:bg-white/5 text-ink-muted/50 cursor-not-allowed",
          )}
          title="Add property"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {modalOpen && type === 'text' && (
        <MarkdownValueModal
          fieldLabel={candidateKey || 'new value'}
          value={String(draft ?? '')}
          onSave={(next) => { setDraft(next); setModalOpen(false) }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

/** Inline value editor used inside the composer; adapts to the chosen type. */
function ComposerValueField({
  type,
  value,
  onChange,
  onExpand,
  onEnter,
}: {
  type: FieldType
  value: unknown
  onChange: (v: unknown) => void
  onExpand: () => void
  onEnter: () => void
}) {
  if (type === 'none') {
    return <span className="text-xs text-ink-muted italic">No value</span>
  }
  if (type === 'group' || type === 'list') {
    return (
      <span className="text-2xs text-ink-muted italic">
        Empty {type === 'group' ? '{ }' : '[ ]'} — add contents after creating
      </span>
    )
  }
  if (type === 'boolean') {
    return <BooleanToggle value={Boolean(value)} onChange={onChange} />
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        value={value as number}
        onChange={(e) => { const n = Number(e.target.value); onChange(Number.isFinite(n) ? n : 0) }}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
        className="w-full px-2 py-1.5 rounded-md bg-black/[0.03] dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs font-mono focus:border-accent-lineage/50 outline-none transition-colors"
      />
    )
  }
  if (type === 'date') {
    return <DateField value={String(value ?? '')} onChange={onChange} />
  }
  if (type === 'url') {
    return <UrlField value={String(value ?? '')} onChange={onChange} />
  }
  if (type === 'tags') {
    return <TagInput value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
  }
  // text
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter() }}
        placeholder="Enter a value…"
        className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-black/[0.03] dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs focus:border-accent-lineage/50 outline-none transition-colors"
      />
      <button
        onClick={onExpand}
        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
        title="Open editor (Markdown)"
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ============================================
// RawJsonEditor — fallback for deeply-nested subtrees
// ============================================

function RawJsonEditor({
  value,
  onChange,
  isOpen,
  onClose,
  inline,
  readOnly,
}: {
  value: unknown
  onChange: (next: unknown) => void
  isOpen: boolean
  onClose: () => void
  inline?: boolean
  readOnly?: boolean
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setDraft(JSON.stringify(value, null, 2))
      setError(null)
    }
  }, [isOpen, value])

  const commit = () => {
    try {
      const parsed = JSON.parse(draft)
      onChange(parsed)
      setError(null)
      if (!inline) onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!isOpen) return null

  const body = (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={readOnly}
        rows={inline ? 8 : 12}
        spellCheck={false}
        className={cn(
          "w-full px-3 py-2 rounded-md bg-black/30 border text-xs font-mono outline-none resize-y custom-scrollbar",
          error ? "border-red-500/40" : "border-black/10 dark:border-white/10 focus:border-accent-lineage/50",
          readOnly && "cursor-default opacity-80",
        )}
      />
      {error && (
        <div className="text-2xs text-red-500">Invalid JSON: {error}</div>
      )}
      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          {!inline && (
            <button
              onClick={onClose}
              className="px-3 py-1 rounded-md text-xs text-ink-muted hover:bg-black/[0.05] dark:hover:bg-white/10"
            >
              Cancel
            </button>
          )}
          <button
            onClick={commit}
            className="px-3 py-1 rounded-md text-xs bg-accent-lineage/20 text-accent-lineage hover:bg-accent-lineage/30"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )

  if (inline) {
    return <div className="rounded-lg border border-glass-border/40 bg-black/10 dark:bg-white/[0.02] p-3">{body}</div>
  }

  return createPortal(
    <>
      <Backdrop open={isOpen} onClick={onClose} zClassName="z-[60]" className="bg-black/40 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 pointer-events-none">
      <AnimatePresence>
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="pointer-events-auto w-full max-w-2xl rounded-xl border border-glass-border bg-canvas-elevated shadow-xl p-5"
        >
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-ink">{readOnly ? 'View JSON' : 'Edit as JSON'}</h4>
            <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/[0.05] dark:hover:bg-white/10">
              <XIcon className="w-4 h-4 text-ink-muted" />
            </button>
          </div>
          {body}
        </motion.div>
      </AnimatePresence>
      </div>
    </>,
    document.body,
  )
}

// ============================================
// Path-grouping — virtual folders over a FLAT key→value map
//
// The stored object is never reshaped: every leaf carries its original flat
// key verbatim, and all mutations operate on that flat object. Splitting on
// '/' is purely for display. Only KEYS are split — values are untouched.
// ============================================

interface Leaf { fullKey: string; value: unknown }
interface TreeNode {
  name: string          // last path segment (display label)
  path: string          // full folder path up to and including `name`
  own?: Leaf            // a flat key exactly equal to this folder's path (collision)
  folders: TreeNode[]
  leaves: Leaf[]
}

function leafLabel(fullKey: string): string {
  const segs = fullKey.split(PATH_SEP).filter(Boolean)
  return segs.length ? segs[segs.length - 1] : fullKey
}

/** Build the display tree from flat entries, preserving first-seen order. */
function buildPathTree(entries: [string, unknown][]): { folders: TreeNode[]; leaves: Leaf[] } {
  const rootFolders: TreeNode[] = []
  const rootLeaves: Leaf[] = []
  const index = new Map<string, TreeNode>()

  for (const [key, value] of entries) {
    const segments = key.split(PATH_SEP).filter((s) => s.length > 0)
    if (segments.length <= 1) {
      rootLeaves.push({ fullKey: key, value })
      continue
    }
    let siblings = rootFolders
    let parentPath = ''
    let node: TreeNode | null = null
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const path = parentPath ? `${parentPath}${PATH_SEP}${seg}` : seg
      let next = index.get(path)
      if (!next) {
        next = { name: seg, path, folders: [], leaves: [] }
        index.set(path, next)
        siblings.push(next)
      }
      siblings = next.folders
      parentPath = path
      node = next
    }
    node!.leaves.push({ fullKey: key, value })
  }

  // Collision pass: a flat key equal to a folder path becomes that folder's
  // own value (rendered inline), so nothing is hidden or lost.
  const resolve = (leaves: Leaf[]): Leaf[] => {
    const kept: Leaf[] = []
    for (const leaf of leaves) {
      const folder = index.get(leaf.fullKey)
      if (folder) folder.own = leaf
      else kept.push(leaf)
    }
    return kept
  }
  const resolvedRootLeaves = resolve(rootLeaves)
  for (const node of index.values()) node.leaves = resolve(node.leaves)

  return { folders: rootFolders, leaves: resolvedRootLeaves }
}

function countMarked(node: TreeNode, marks: PropertyMarks['marks']): number {
  let n = node.own && marks.has(node.own.fullKey) ? 1 : 0
  for (const l of node.leaves) if (marks.has(l.fullKey)) n++
  for (const f of node.folders) n += countMarked(f, marks)
  return n
}

function countLeaves(node: TreeNode): number {
  let n = (node.own ? 1 : 0) + node.leaves.length
  for (const f of node.folders) n += countLeaves(f)
  return n
}

// --- Flat mutation helpers (order-preserving) ---

function setKeyValue(obj: Record<string, unknown>, key: string, v: unknown): Record<string, unknown> {
  return { ...obj, [key]: v }
}

function renameKey(obj: Record<string, unknown>, oldKey: string, newKey: string): Record<string, unknown> {
  if (oldKey === newKey || !newKey.trim()) return obj
  if (Object.prototype.hasOwnProperty.call(obj, newKey)) return obj
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) next[k === oldKey ? newKey : k] = v
  return next
}

function deleteKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = obj
  return rest
}

function renamePrefix(obj: Record<string, unknown>, oldPrefix: string, newPrefix: string): Record<string, unknown> {
  if (oldPrefix === newPrefix || !newPrefix.trim()) return obj
  const mapped: Array<[string, unknown, string]> = []
  for (const [k, v] of Object.entries(obj)) {
    let nk = k
    if (k === oldPrefix) nk = newPrefix
    else if (k.startsWith(oldPrefix + PATH_SEP)) nk = newPrefix + k.slice(oldPrefix.length)
    mapped.push([nk, v, k])
  }
  // Abort if a renamed key would collide with an untouched key.
  const unchanged = new Set(mapped.filter(([nk, , k]) => nk === k).map(([nk]) => nk))
  for (const [nk, , k] of mapped) {
    if (nk !== k && unchanged.has(nk)) return obj
  }
  const next: Record<string, unknown> = {}
  for (const [nk, v] of mapped) next[nk] = v
  return next
}

function deletePrefix(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === prefix || k.startsWith(prefix + PATH_SEP)) continue
    next[k] = v
  }
  return next
}

function addEntry(obj: Record<string, unknown>, prefix: string, name: string, value: unknown): Record<string, unknown> {
  if (!name.trim()) return obj
  const key = prefix ? `${prefix}${PATH_SEP}${name.trim()}` : name.trim()
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj
  return { ...obj, [key]: value }
}

interface FlatApi {
  updateValue: (fullKey: string, v: unknown) => void
  renameLeaf: (fullKey: string, parentPath: string, newSegment: string) => void
  deleteKey: (fullKey: string) => void
  renameFolder: (oldPath: string, newPath: string) => void
  deleteFolder: (path: string) => void
  addEntry: (prefix: string, name: string, value: unknown) => void
  existingKeys: () => string[]
  /** Put a key back as it was read (its value, or gone if it is new). */
  revert: (fullKey: string) => void
}

// ============================================
// GroupedObjectRoot — Tree/Flat toggle + search over a flat key map
// ============================================

function pruneTree(
  folders: TreeNode[],
  leaves: Leaf[],
  q: string,
): { folders: TreeNode[]; leaves: Leaf[] } {
  const leafMatch = (l: Leaf) => l.fullKey.toLowerCase().includes(q) || searchableText(l.value).includes(q)
  const pruneNode = (node: TreeNode): TreeNode | null => {
    if (node.name.toLowerCase().includes(q)) return node // name hit → keep whole subtree
    const subFolders = node.folders.map(pruneNode).filter(Boolean) as TreeNode[]
    const subLeaves = node.leaves.filter(leafMatch)
    const own = node.own && leafMatch(node.own) ? node.own : undefined
    if (subFolders.length || subLeaves.length || own) {
      return { ...node, folders: subFolders, leaves: subLeaves, own }
    }
    return null
  }
  return {
    folders: folders.map(pruneNode).filter(Boolean) as TreeNode[],
    leaves: leaves.filter(leafMatch),
  }
}

function GroupedObjectRoot({
  value,
  onChange,
  readOnlyKeys,
  readOnly,
  searchable,
  original,
  startAdding = false,
  suggestions,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  readOnlyKeys?: string[]
  readOnly?: boolean
  searchable?: boolean
  original?: Record<string, unknown>
  startAdding?: boolean
  suggestions?: string[]
}) {
  const inline = useContext(InlineModeContext)
  const [flat, setFlat] = useState(false)
  const [display, setDisplay] = useState<DisplayMode>('formatted')
  const [editTextMode, setEditTextMode] = useState<EditTextMode>('rich')
  const [query, setQuery] = useState('')
  // `true`, or the name a suggestion starts the form with.
  const [addingRoot, setAddingRoot] = useState<boolean | string>(startAdding)

  const entries = Object.entries(value)
  const tree = useMemo(() => buildPathTree(entries), [value])
  // What each property's edit did — computed once per edit, handed to rows as plain values so
  // only the rows whose mark changed re-render.
  const { marks, removed } = useMemo(() => propertyMarks(value, readOnly ? undefined : original), [value, original, readOnly])

  // Keep `api` identity stable across edits (it reads the latest value/onChange
  // through a ref) so memoized rows don't all re-render when one value changes.
  const liveRef = useRef({ value, onChange, original })
  liveRef.current = { value, onChange, original }
  const api: FlatApi = useMemo(() => ({
    updateValue: (fullKey, v) => liveRef.current.onChange(setKeyValue(liveRef.current.value, fullKey, v)),
    renameLeaf: (fullKey, parentPath, newSegment) =>
      liveRef.current.onChange(renameKey(liveRef.current.value, fullKey, parentPath ? `${parentPath}${PATH_SEP}${newSegment}` : newSegment)),
    deleteKey: (fullKey) => liveRef.current.onChange(deleteKey(liveRef.current.value, fullKey)),
    renameFolder: (oldPath, newPath) => liveRef.current.onChange(renamePrefix(liveRef.current.value, oldPath, newPath)),
    deleteFolder: (path) => liveRef.current.onChange(deletePrefix(liveRef.current.value, path)),
    addEntry: (prefix, name, val) => liveRef.current.onChange(addEntry(liveRef.current.value, prefix, name, val)),
    existingKeys: () => Object.keys(liveRef.current.value),
    // Back as it was read: its old value, or — for one added since — gone.
    revert: (fullKey) => {
      const { value: v, original: o } = liveRef.current
      if (o && Object.prototype.hasOwnProperty.call(o, fullKey)) liveRef.current.onChange(setKeyValue(v, fullKey, o[fullKey]))
      else liveRef.current.onChange(deleteKey(v, fullKey))
    },
  }), [])

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => (q ? pruneTree(tree.folders, tree.leaves, q) : tree), [tree, q])
  const shownRemoved = useMemo(
    () => (q ? removed.filter(([k, v]) => k.toLowerCase().includes(q) || searchableText(v).includes(q)) : removed),
    [removed, q],
  )

  const empty = entries.length === 0
  const readsFormatted = readOnly || inline
  const offered = useMemo(
    () => (readOnly ? [] : (suggestions ?? []).filter((k) => !Object.prototype.hasOwnProperty.call(value, k)).slice(0, 5)),
    [suggestions, value, readOnly],
  )

  return (
    <DisplayModeContext.Provider value={readsFormatted ? display : 'source'}>
    <EditTextModeContext.Provider value={editTextMode}>
    <div>
      {/* Toolbar: search + Formatted/Source (view) or Rich/Source (edit) + Tree/Flat toggles */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {searchable && (
          <div className="flex-1 min-w-[8rem]">
            <SearchBox
              query={query}
              onChange={setQuery}
              placeholder={`Search ${entries.length} ${entries.length === 1 ? 'property' : 'properties'}…`}
            />
          </div>
        )}
        {readsFormatted ? (
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/5 dark:bg-white/5 flex-shrink-0">
            <ModalTab active={display === 'formatted'} onClick={() => setDisplay('formatted')} label="Formatted" />
            <ModalTab active={display === 'source'} onClick={() => setDisplay('source')} label="Markdown" />
          </div>
        ) : (
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/5 dark:bg-white/5 flex-shrink-0">
            <ModalTab active={editTextMode === 'rich'} onClick={() => setEditTextMode('rich')} label="Rich" />
            <ModalTab active={editTextMode === 'source'} onClick={() => setEditTextMode('source')} label="Source" />
          </div>
        )}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/5 dark:bg-white/5 flex-shrink-0">
          <ModalTab active={!flat} onClick={() => setFlat(false)} label="Tree" />
          <ModalTab active={flat} onClick={() => setFlat(true)} label="Flat" />
        </div>
      </div>

      {flat ? (
        <>
          <ObjectBody
            value={value}
            onChange={onChange}
            readOnlyKeys={readOnlyKeys}
            depth={0}
            bare
            readOnly={readOnly}
            externalQuery={searchable ? query : undefined}
            marks={marks}
            onRevert={api.revert}
          />
          <RemovedRows rows={shownRemoved} onRestore={api.revert} />
        </>
      ) : empty && shownRemoved.length === 0 ? (
        readOnly ? (
          <div className="text-xs text-ink-muted italic px-2 py-2">No properties</div>
        ) : (
          <RootAdder api={api} adding={addingRoot} setAdding={setAddingRoot} suggestions={offered} />
        )
      ) : (
        <div className="space-y-1">
          {visible.folders.map((node) => (
            <FolderGroup key={node.path} node={node} depth={0} readOnly={readOnly} query={q} forceExpand={!!q} api={api} marks={marks} />
          ))}
          {visible.leaves.map((leaf) => (
            <LeafRow key={leaf.fullKey} leaf={leaf} parentPath="" depth={0} readOnly={readOnly} query={q} api={api}
              mark={marks.get(leaf.fullKey)?.mark} was={marks.get(leaf.fullKey)?.was} />
          ))}
          <RemovedRows rows={shownRemoved} onRestore={api.revert} />
          {q && visible.folders.length === 0 && visible.leaves.length === 0 && shownRemoved.length === 0 && (
            <div className="text-xs text-ink-muted px-2 py-3">No properties match “{query.trim()}”.</div>
          )}
          {!readOnly && !q && (
            <RootAdder api={api} adding={addingRoot} setAdding={setAddingRoot} suggestions={offered} />
          )}
        </div>
      )}
    </div>
    </EditTextModeContext.Provider>
    </DisplayModeContext.Provider>
  )
}

function RootAdder({ api, adding, setAdding, suggestions = [] }: {
  api: FlatApi
  /** `true`, or the name to start the form with. */
  adding: boolean | string
  setAdding: (b: boolean | string) => void
  /** Names worth adding, one click each. */
  suggestions?: string[]
}) {
  return adding ? (
    <PropertyComposer
      key={typeof adding === 'string' ? adding : ''}
      initialKey={typeof adding === 'string' ? adding : undefined}
      onAdd={(name, val) => { api.addEntry('', name, val); setAdding(false) }}
      onCancel={() => setAdding(false)}
      existingKeys={api.existingKeys()}
      variant="object"
    />
  ) : (
    <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap mt-1.5 ml-1">
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-accent-lineage transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Add property
      </button>
      {suggestions.length > 0 && (
        <>
          <HoverTip label="Others of this type have these" detail="Click one to add it here" className="inline-flex">
            <span className="flex items-center gap-1 text-2xs text-ink-muted"><Sparkles className="w-3 h-3 text-accent-lineage" aria-hidden />Suggested</span>
          </HoverTip>
          {suggestions.map((k) => (
            <button
              key={k}
              onClick={() => setAdding(k)}
              aria-label={`Add ${k}`}
              className="px-2 h-6 rounded-full border border-dashed border-glass-border text-2xs font-medium text-ink-secondary hover:text-accent-lineage hover:border-accent-lineage/50 hover:bg-accent-lineage/5 transition-colors max-w-[10rem] truncate"
            >
              + {k}
            </button>
          ))}
        </>
      )}
    </div>
  )
}

/** Properties read but removed since — struck through, each with Restore. */
function RemovedRows({ rows, onRestore }: { rows: [string, unknown][]; onRestore: (key: string) => void }) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1 pt-1">
      {rows.map(([key, was]) => (
        <div key={key} className="relative flex items-center gap-1.5 py-1.5 pl-5 pr-1 rounded-lg bg-rose-500/[0.04] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-rose-500">
          <span className="basis-[132px] flex-shrink-0 min-w-0 text-xs font-mono text-ink-muted line-through truncate">{key}</span>
          <span className="px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide bg-rose-500/12 text-rose-700 dark:text-rose-300 flex-shrink-0">Removed</span>
          <span className="flex-1 min-w-0 text-xs text-ink-muted line-through truncate">{shortValue(was)}</span>
          <button
            onClick={() => onRestore(key)}
            className="flex items-center gap-1 px-2 h-6 rounded-md text-2xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 flex-shrink-0"
          >
            <Undo2 className="w-3 h-3" aria-hidden />
            Restore
          </button>
        </div>
      ))}
    </div>
  )
}

// ============================================
// LeafRow — a single flat key rendered via PropertyRow, path-aware callbacks
// ============================================

const LeafRow = memo(function LeafRow({
  leaf,
  parentPath,
  depth,
  readOnly,
  query,
  api,
  mark,
  was,
}: {
  leaf: Leaf
  parentPath: string
  depth: number
  readOnly?: boolean
  query: string
  api: FlatApi
  mark?: ChangeMark
  was?: unknown
}) {
  return (
    <PropertyRow
      rowKey={leafLabel(leaf.fullKey)}
      value={leaf.value}
      depth={depth}
      readOnly={readOnly}
      query={query}
      onKeyChange={(seg) => api.renameLeaf(leaf.fullKey, parentPath, seg)}
      onValueChange={(v) => api.updateValue(leaf.fullKey, v)}
      onDelete={() => api.deleteKey(leaf.fullKey)}
      mark={mark}
      was={was}
      onRevert={mark ? () => api.revert(leaf.fullKey) : undefined}
    />
  )
}, (prev, next) =>
  // `buildPathTree` (memoized on [value]) hands back equal leaf values for
  // unchanged keys, so only the edited leaf re-renders.
  prev.leaf.fullKey === next.leaf.fullKey &&
  prev.leaf.value === next.leaf.value &&
  prev.parentPath === next.parentPath &&
  prev.depth === next.depth &&
  prev.readOnly === next.readOnly &&
  prev.query === next.query &&
  prev.api === next.api &&
  prev.mark === next.mark &&
  prev.was === next.was)

// ============================================
// FolderGroup — expandable folder header + recursive children
// ============================================

function FolderGroup({
  node,
  depth,
  readOnly,
  query,
  forceExpand,
  api,
  marks,
}: {
  node: TreeNode
  depth: number
  readOnly?: boolean
  query: string
  forceExpand?: boolean
  api: FlatApi
  marks?: PropertyMarks['marks']
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(node.name)
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { setNameDraft(node.name) }, [node.name])

  const isOpen = forceExpand || expanded
  const parentPath = node.path.includes(PATH_SEP) ? node.path.slice(0, node.path.lastIndexOf(PATH_SEP)) : ''
  const count = countLeaves(node)
  // Edited properties inside — said on the folder, so a closed one still shows its changes.
  const edited = marks && marks.size > 0 ? countMarked(node, marks) : 0

  const nameCancelled = useRef(false)
  const commitName = () => {
    if (nameCancelled.current) { nameCancelled.current = false; return }
    setEditingName(false)
    const next = nameDraft.trim()
    if (next && next !== node.name && !next.includes(PATH_SEP)) {
      api.renameFolder(node.path, parentPath ? `${parentPath}${PATH_SEP}${next}` : next)
    } else {
      setNameDraft(node.name)
    }
  }

  const FolderIcon = isOpen ? FolderOpen : Folder

  return (
    <div className="group">
      <div className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors">
        <button
          onClick={() => setExpanded((e) => !e)}
          disabled={forceExpand}
          className="w-5 h-5 flex items-center justify-center text-ink-muted hover:text-ink flex-shrink-0"
          title={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <FolderIcon className="w-4 h-4 text-amber-500 flex-shrink-0" />

        {/* Folder name (inline-renamable) */}
        <div className="basis-[140px] flex-shrink min-w-0 flex items-center">
          {readOnly ? (
            <span className="text-xs font-semibold text-ink truncate" title={node.path}>
              <HighlightedText text={node.name} query={query} />
            </span>
          ) : editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  nameCancelled.current = true
                  setNameDraft(node.name)
                  setEditingName(false)
                }
              }}
              className="text-xs font-semibold px-1.5 py-0.5 rounded bg-black/[0.06] dark:bg-white/10 border border-accent-lineage/40 outline-none min-w-0 w-full"
            />
          ) : (
            <button
              onClick={() => { nameCancelled.current = false; setEditingName(true) }}
              className="text-xs font-semibold text-ink hover:text-accent-lineage truncate text-left max-w-full"
              title={`${node.path} — click to rename folder`}
            >
              <HighlightedText text={node.name} query={query} />
            </button>
          )}
        </div>

        <span className="text-2xs text-ink-muted flex-1 flex items-center gap-1.5">
          {count} {count === 1 ? 'item' : 'items'}
          {edited > 0 && (
            <span className={cn('inline-flex items-center gap-1 font-semibold', fieldTone('changed').text)}>
              <span className={cn('w-1.5 h-1.5 rounded-full', fieldTone('changed').bar)} aria-hidden />{edited} edited
            </span>
          )}
        </span>

        {/* Folder actions */}
        {!readOnly && (
          <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
            <button
              onClick={() => { setAdding(true); setExpanded(true) }}
              className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10"
              title="Add property in this folder"
            >
              <FolderPlus className="w-3 h-3" />
            </button>
            {confirmDelete ? (
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => api.deleteFolder(node.path)}
                  className="px-1.5 h-6 flex items-center justify-center rounded text-2xs font-semibold text-red-500 bg-red-500/10 hover:bg-red-500/20"
                  title="Confirm delete"
                >
                  Delete {count}?
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10"
                  title="Keep folder"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-red-500 hover:bg-red-500/10"
                title="Delete folder and all its properties"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {isOpen && (
        <div className="ml-5 pl-3 border-l border-glass-border/40 space-y-1">
          {node.own && (
            <LeafRow leaf={node.own} parentPath={parentPath} depth={depth + 1} readOnly={readOnly} query={query} api={api}
              mark={marks?.get(node.own.fullKey)?.mark} was={marks?.get(node.own.fullKey)?.was} />
          )}
          {node.folders.map((child) => (
            <FolderGroup key={child.path} node={child} depth={depth + 1} readOnly={readOnly} query={query} forceExpand={forceExpand} api={api} marks={marks} />
          ))}
          {node.leaves.map((leaf) => (
            <LeafRow key={leaf.fullKey} leaf={leaf} parentPath={node.path} depth={depth + 1} readOnly={readOnly} query={query} api={api}
              mark={marks?.get(leaf.fullKey)?.mark} was={marks?.get(leaf.fullKey)?.was} />
          ))}
          {!readOnly && (
            adding ? (
              <PropertyComposer
                onAdd={(name, val) => { api.addEntry(node.path, name, val); setAdding(false) }}
                onCancel={() => setAdding(false)}
                existingKeys={api.existingKeys()}
                variant="object"
                prefixLabel={node.path}
              />
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors mt-1 ml-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Add property
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

export default PropertyEditor
