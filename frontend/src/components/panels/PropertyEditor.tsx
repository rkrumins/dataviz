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

import { useState, useCallback, useMemo, useRef, useEffect, memo, createContext, useContext, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
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
  FolderPlus,
  Undo2,
  Sparkles,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { HighlightedText } from '@/components/ui/HighlightedText'
import { HoverTip } from '@/components/ui/HoverTip'
import { fieldTone, STATE_DOT } from '@/features/versioning/model/changeTone'
import { FieldCountChips } from '@/features/versioning/components/ChangeSummary'
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
  isLongText,
} from './property/valueWidgets'
import { RichValue, NOT_SET } from './property/RichValue'
import { MarkdownValueModal } from './property/MarkdownValueEditor'
import { InlineValue } from './property/InlineValue'
import { propertyMarks, shortValue, type ChangeMark, type PropertyMarks } from './property/changeMarks'
import { detectValue, parsePastedLines, rankSuggestions, type PastedProperty, type PropertySuggestion } from './property/composerModel'
import { useRecentPropertyKeys } from '@/store/recentPropertyKeys'
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'

// ============================================
// Types
// ============================================

type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'

/** In read-only (View) mode, whether string values render as formatted Markdown
 *  or as raw source. Irrelevant in edit mode (values are editable inputs). */
type DisplayMode = 'formatted' | 'source'
const DisplayModeContext = createContext<DisplayMode>('formatted')

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
  /** The properties as published (main where the draft began): rows then say what the draft
   *  changed, saved or not yet — read-only too — and Revert puts a property back as published. */
  published?: Record<string, unknown>
  /** Open the add-property form straight away (an empty entity's "Add properties"). */
  startAdding?: boolean
  /** Property names worth adding — offered as one-click starts next to "Add property", and as the
   *  name is typed (with how many others of the type carry each, and an example value). */
  suggestions?: ReadonlyArray<string | PropertySuggestion>
  /** Remember which sections are open under this name (one per kind of entity), with the
   *  drawer's own sections. Without it, they start the same way each time. */
  sectionsKey?: string
  /** Properties shown at a glance: marked so, where they are listed. */
  featuredKeys?: readonly string[]
  /** Feature a property at a glance, or stop — offered on each row. */
  onToggleFeatured?: (key: string) => void
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
  published,
  startAdding,
  suggestions,
  sectionsKey,
  featuredKeys,
  onToggleFeatured,
}: PropertyEditorProps) {
  return (
    <InlineModeContext.Provider value={!!inline && !readOnly}>
      <PropertyEditorRoot value={value} onChange={onChange} readOnlyKeys={readOnlyKeys} bare={bare} readOnly={readOnly}
        searchable={searchable} groupByPath={groupByPath} original={original} published={published}
        startAdding={startAdding} suggestions={suggestions} sectionsKey={sectionsKey}
        featuredKeys={featuredKeys} onToggleFeatured={onToggleFeatured} />
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
  published,
  startAdding,
  suggestions,
  sectionsKey,
  featuredKeys,
  onToggleFeatured,
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
        published={published}
        startAdding={startAdding}
        suggestions={suggestions}
        sectionsKey={sectionsKey}
        featuredKeys={featuredKeys}
        onToggleFeatured={onToggleFeatured}
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
  className,
}: {
  query: string
  onChange: (q: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <div className={cn('relative mb-2', className)}>
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
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded text-ink-muted hover:text-ink"
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
  /** Root only: the keys shown at a glance, and featuring one. */
  featured?: ReadonlySet<string>
  onToggleFeatured?: (key: string) => void
}

function ObjectBody({ value, onChange, readOnlyKeys, depth, bare, readOnly, searchable, externalQuery, marks, onRevert, featured, onToggleFeatured }: ObjectBodyProps) {
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
            locked={depth === 0 && readOnlyKeys?.includes(key)}
            depth={depth}
            query={isSearchRoot ? query : ''}
            onKeyChange={(nk) => updateKey(key, nk)}
            onValueChange={(nv) => updateValue(key, nv)}
            onDelete={() => deleteKey(key)}
            mark={marks?.get(key)?.mark}
            was={marks?.get(key)?.was}
            unsaved={marks?.get(key)?.unsaved}
            onRevert={onRevert && marks?.has(key) ? () => onRevert(key) : undefined}
            featured={featured?.has(key)}
            onToggleFeatured={onToggleFeatured ? () => onToggleFeatured(key) : undefined}
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
                rowKey={`Item ${item.index + 1}`}
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
              rowKey={`Item ${item.index + 1}`}
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
  /** A key the caller keeps as it is (`readOnlyKeys`): shown with a lock. */
  locked?: boolean
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
  /** The change is staged, not saved in the draft yet. */
  unsaved?: boolean
  /** Put the row back as it was read. */
  onRevert?: () => void
  /** Shown at a glance (marked so). */
  featured?: boolean
  /** Feature it at a glance, or stop. */
  onToggleFeatured?: () => void
}

/** A key as stored. A flat key's folders (`Technical/Physical/`) read quieter than its own name;
 *  a long key wraps to two lines, the whole of it on hover. */
function KeyLabel({ rowKey, query, locked, tip = true }: { rowKey: string; query: string; locked?: boolean; tip?: boolean }) {
  const cut = rowKey.lastIndexOf(PATH_SEP)
  const folders = cut > 0 && cut < rowKey.length - 1 ? rowKey.slice(0, cut + 1) : ''
  const own = folders ? rowKey.slice(cut + 1) : rowKey
  const label = (
    <span className="min-w-0 text-xs font-mono break-all line-clamp-2">
      {folders && <span className="text-ink-muted"><HighlightedText text={folders} query={query} /></span>}
      <span className="text-ink-secondary"><HighlightedText text={own} query={query} /></span>
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full">
      {locked && (
        <HoverTip label="Kept as it is" detail="This property can't be changed here" className="inline-flex flex-shrink-0">
          <Lock aria-label="Locked" className="w-3 h-3 text-ink-muted" />
        </HoverTip>
      )}
      {tip && rowKey.length > 28 ? <HoverTip label={rowKey} className="inline-flex min-w-0">{label}</HoverTip> : label}
    </span>
  )
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
  locked,
  isArrayItem,
  depth,
  query = '',
  onKeyChange,
  onValueChange,
  onDelete,
  mark,
  was,
  unsaved = true,
  onRevert,
  featured,
  onToggleFeatured,
}: PropertyRowProps) {
  const inline = useContext(InlineModeContext)
  const fieldType = inferFieldType(value)
  const isContainer = fieldType === 'group' || fieldType === 'list'
  // Long text takes the row's whole width, under its key: a paragraph squeezed beside the key
  // reads as a column of three words.
  const stacked = fieldType === 'text' && typeof value === 'string' && isLongText(value)
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
        stacked && "flex-wrap gap-y-0.5",
        "hover:bg-black/[0.025] dark:hover:bg-white/[0.03] transition-colors",
        mark && cn("before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full", MARK_STYLE[mark].bar,
          // Saved in the draft: the quieter, solid form; staged: full strength.
          !unsaved && 'before:opacity-60'),
      )}>
        {/* Expand / drag handle */}
        <div className="flex items-center h-6 w-4 flex-shrink-0">
          {isContainer ? (
            <button
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-expanded={expanded}
              className="w-4 h-5 flex items-center justify-center text-ink-muted hover:text-ink"
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : isArrayItem && !readOnly ? (
            <GripVertical className="w-3.5 h-3.5 text-ink-muted/40 cursor-grab" />
          ) : (
            <span className="w-4" />
          )}
        </div>

        {/* Key column — one width for every row, so values align; a long key wraps (two lines,
            the whole of it on hover) rather than being cut off. */}
        <div className={cn('min-h-6 py-[3px] flex flex-wrap items-center gap-x-1.5 gap-y-0.5',
          stacked ? 'flex-1 min-w-0' : 'basis-[36%] min-w-[112px] max-w-[200px] flex-shrink-0')}>
          {isArrayItem ? (
            <span className="text-xs text-ink-muted">{rowKey}</span>
          ) : readOnly ? (
            <KeyLabel rowKey={rowKey} query={query} locked={locked} />
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
            <HoverTip label="Rename" detail={rowKey} className="inline-flex min-w-0 max-w-full">
              <button
                onClick={() => { keyCancelled.current = false; setEditingKey(true) }}
                aria-label={`Rename ${rowKey}`}
                className="min-w-0 max-w-full text-left hover:text-accent-lineage [&:hover_*]:text-accent-lineage"
              >
                <KeyLabel rowKey={rowKey} query={query} tip={false} />
              </button>
            </HoverTip>
          )}
          {mark && (
            <HoverTip
              label={mark === 'new' ? 'Added' : `Was: ${shortValue(was)}`}
              detail={unsaved ? 'Not saved yet — saved with Review & Save' : 'Saved in this draft — published when it merges'}
              className="inline-flex flex-shrink-0 ml-1.5"
            >
              <span className={cn('inline-flex items-center gap-1 px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide', MARK_STYLE[mark].badge)}>
                {/* Hollow and dashed: not saved yet; solid: saved in the draft. */}
                <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', STATE_DOT[unsaved ? 'unsaved' : 'saved'])} />
                {MARK_STYLE[mark].label}
                <span className="sr-only">{unsaved ? ', not saved yet' : ', saved in this draft'}</span>
              </span>
            </HoverTip>
          )}
          {featured && (
            <HoverTip label="Shown at a glance" detail="At the top of the details, for every entity of this type" className="inline-flex flex-shrink-0">
              <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[9.5px] font-semibold bg-accent-lineage/10 text-accent-lineage">
                <Sparkles aria-hidden className="w-2.5 h-2.5" />At a glance
              </span>
            </HoverTip>
          )}
        </div>

        {/* Value column — flexible, consistent across all kinds; long text on a line of its own */}
        <div className={cn('flex-1 min-w-0', stacked && 'order-last basis-full pl-[22px]')}>
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
          {mark === 'changed' && (
            // What it was, under what it is: one glance says the change.
            <HoverTip label={`Was: ${shortValue(was)}`} className="block min-w-0">
              <span className="block mt-0.5 text-[10.5px] text-ink-muted truncate">
                was <span className="line-through decoration-rose-400/70">{shortValue(was)}</span>
              </span>
            </HoverTip>
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
            <HoverTip label="Edit as raw JSON" className="inline-flex">
              <button
                onClick={() => setRawJsonOpen(true)}
                aria-label="Edit as raw JSON"
                className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10"
              >
                <Code className="w-3 h-3" />
              </button>
            </HoverTip>
          )}
          {onToggleFeatured && !isArrayItem && (
            <HoverTip label={featured ? 'Stop showing at a glance' : 'Show at a glance'}
              detail="At the top of the details, for every entity of this type — in your view" className="inline-flex">
              <button
                onClick={onToggleFeatured}
                aria-pressed={!!featured}
                aria-label={featured ? `Stop showing ${rowKey} at a glance` : `Show ${rowKey} at a glance`}
                className={cn('w-6 h-6 flex items-center justify-center rounded hover:bg-black/[0.05] dark:hover:bg-white/10',
                  featured ? 'text-accent-lineage' : 'text-ink-muted hover:text-ink')}
              >
                <Sparkles className="w-3 h-3" />
              </button>
            </HoverTip>
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
    <HoverTip label={readOnly ? 'View full value' : 'Open editor (Markdown)'} className="inline-flex flex-shrink-0">
      <button
        onClick={() => openModal(false)}
        aria-label={readOnly ? 'View full value' : 'Open editor (Markdown)'}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-muted/70 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
      >
        <Maximize2 className="w-3 h-3" />
      </button>
    </HoverTip>
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
  // Drawn as what it is (property/RichValue); copy, and the full viewer for text long enough to clamp.
  if (readOnly) {
    const s = typeof value === 'string' ? value : ''
    const long = fieldType === 'text' && display !== 'source' && isLongText(s)
    return (
      <>
        <div className="flex items-start gap-1 min-h-6">
          <div className="flex-1 min-w-0 py-[3px]">
            <RichValue value={value} fieldKey={fieldLabel} query={query} source={display === 'source'} onOpen={openModal} />
          </div>
          {(s !== '' || long) && (
            <div className="flex items-start">
              {s !== '' && <CopyButton text={s} />}
              {long && expandButton}
            </div>
          )}
        </div>
        {modalOpen && (
          <MarkdownValueModal fieldLabel={fieldLabel} value={s} readOnly initialMaximized={modalMaximized} onSave={() => setModalOpen(false)} onClose={() => setModalOpen(false)} />
        )}
      </>
    )
  }

  // ---------------------------------------------------------------- editable
  if (fieldType === 'none') {
    return <span className="text-xs text-ink-muted h-6 flex items-center">{NOT_SET}</span>
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
      aria-label={copied ? 'Copied' : 'Copy value'}
      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
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
        aria-label={readOnly ? meta.label : 'Change type'}
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
  suggestions = [],
  onAddMany,
  onUpdateExisting,
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
  /** Names others of this type carry, offered as the name is typed. */
  suggestions?: readonly PropertySuggestion[]
  /** Several properties pasted at once, added as one change (one Undo). */
  onAddMany?: (entries: Array<[string, unknown]>) => void
  /** A name already there: set its value instead. */
  onUpdateExisting?: (key: string, value: unknown) => void
}) {
  const smartish = variant === 'object'
  const [key, setKey] = useState(initialKey)
  const [type, setType] = useState<FieldType>('text')
  const [draft, setDraft] = useState<unknown>('')
  // Until a type is picked, the value is typed as text and what it is is detected (a number, yes/no,
  // a date, a link) — stored as that.
  const [typeChosen, setTypeChosen] = useState(!smartish)
  const [text, setText] = useState('')
  const detected = useMemo(() => detectValue(text), [text])
  const [modalOpen, setModalOpen] = useState(false)
  const [pasted, setPasted] = useState<PastedProperty[] | null>(null)
  const [highlight, setHighlight] = useState(-1)
  const [nameFocused, setNameFocused] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const recent = useRecentPropertyKeys((st) => st.keys)
  const remember = useRecentPropertyKeys((st) => st.remember)

  const candidateKey = prefixLabel ? `${prefixLabel}/${key.trim()}` : key.trim()
  const isDup = variant === 'object' && key.trim() !== '' && existingKeys.includes(candidateKey)
  const canSubmit = variant === 'array' || (key.trim() !== '' && !isDup)
  const value = typeChosen ? draft : detected.value
  const shownType: FieldType = typeChosen ? type : detected.type
  const offered = useMemo(
    () => (smartish ? rankSuggestions(key, suggestions, recent, existingKeys.map((k) => (prefixLabel && k.startsWith(`${prefixLabel}/`) ? k.slice(prefixLabel.length + 1) : k))) : []),
    [smartish, key, suggestions, recent, existingKeys, prefixLabel])
  const listOpen = nameFocused && offered.length > 0 && !(offered.length === 1 && offered[0].key === key.trim())
  const picked = suggestions.find((p) => p.key === key.trim())

  const changeType = (t: FieldType) => {
    setType(t)
    setTypeChosen(true)
    setDraft(text.trim() ? coerceToType(detected.value, t) : valueForType(t))
  }
  const pick = (k: string) => {
    setKey(k)
    setHighlight(-1)
    setNameFocused(false)
  }

  /** Add it; `next`: and start another (⌘↵), else close. */
  const submit = (next = false) => {
    if (!canSubmit) return
    const k = variant === 'array' ? '' : key.trim()
    onAdd(k, value)
    if (k) remember([candidateKey])
    if (next && smartish) {
      setKey(''); setText(''); setDraft(''); setTypeChosen(false); setType('text')
      requestAnimationFrame(() => nameRef.current?.focus())
    } else {
      onCancel()
    }
  }
  const updateInstead = () => {
    onUpdateExisting?.(candidateKey, value)
    onCancel()
  }
  const addPasted = () => {
    if (!pasted?.length) return
    const entries = pasted.filter((p) => !existingKeys.includes(prefixLabel ? `${prefixLabel}/${p.key}` : p.key))
      .map((p): [string, unknown] => [prefixLabel ? `${prefixLabel}/${p.key}` : p.key, p.value])
    if (entries.length) {
      onAddMany?.(entries)
      remember(entries.map(([k]) => k))
    }
    onCancel()
  }
  // Several lines pasted read as several properties: say so, and add them in one go.
  const onPaste = (e: React.ClipboardEvent) => {
    if (!smartish || !onAddMany) return
    const many = parsePastedLines(e.clipboardData.getData('text'))
    if (many.length) { e.preventDefault(); setPasted(many) }
  }

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pasted) setPasted(null); else onCancel() }
    // ⌘↵ adds it and starts the next — not the drawer's own ⌘↵.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); submit(true) }
  }

  if (pasted) {
    const dupes = pasted.filter((p) => existingKeys.includes(prefixLabel ? `${prefixLabel}/${p.key}` : p.key)).length
    const adding = pasted.length - dupes
    return (
      <div onKeyDown={onFormKeyDown}
        className="mt-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-accent-lineage/30 p-3 space-y-2.5 shadow-sm">
        <p className="text-xs font-semibold text-ink">
          {pasted.length.toLocaleString()} properties pasted
          {dupes > 0 && <span className="font-normal text-ink-muted"> · {dupes} already there, left as they are</span>}
        </p>
        <div className="max-h-56 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border divide-y divide-glass-border">
          {pasted.map((p) => {
            const there = existingKeys.includes(prefixLabel ? `${prefixLabel}/${p.key}` : p.key)
            return (
              <div key={p.key} className={cn('flex items-center gap-2 px-2.5 py-1.5 text-xs', there && 'opacity-50')}>
                <span className="basis-[40%] min-w-0 font-mono text-ink truncate">{p.key}</span>
                <span className="flex-1 min-w-0 text-ink-secondary truncate">{shortValue(p.value)}</span>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  {there ? 'There' : FIELD_TYPE_META[p.type].label}
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => setPasted(null)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5 transition-colors">
            Back
          </button>
          <button type="button" onClick={addPasted} disabled={adding === 0} autoFocus
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-accent-lineage text-white hover:brightness-110 shadow-sm disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" aria-hidden />Add {adding.toLocaleString()}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      onKeyDown={onFormKeyDown}
      className="mt-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-accent-lineage/30 p-3 space-y-2.5 shadow-sm"
    >
      {/* Row 1: name (with what others of this type carry) + type */}
      <div className="flex items-center gap-2">
        {prefixLabel && (
          <HoverTip label={prefixLabel} className="inline-flex flex-shrink-0">
            <span className="text-2xs font-mono text-ink-muted bg-black/[0.03] dark:bg-white/5 rounded px-1.5 py-0.5 max-w-[140px] truncate">
              {prefixLabel}/
            </span>
          </HoverTip>
        )}
        {variant === 'object' ? (
          <div className="relative flex-1 min-w-0">
            <input
              ref={nameRef}
              autoFocus
              value={key}
              placeholder="Property name"
              aria-label="Property name"
              role="combobox"
              aria-expanded={listOpen}
              aria-autocomplete="list"
              onChange={(e) => { setKey(e.target.value); setHighlight(-1); setNameFocused(true) }}
              onFocus={() => setNameFocused(true)}
              onBlur={() => window.setTimeout(() => setNameFocused(false), 120)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (listOpen && e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(offered.length - 1, h + 1)); return }
                if (listOpen && e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(-1, h - 1)); return }
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  if (listOpen && highlight >= 0) { e.preventDefault(); pick(offered[highlight].key); return }
                  submit()
                }
              }}
              className={cn(
                "w-full text-sm px-2.5 py-1.5 rounded-md bg-black/[0.03] dark:bg-white/5 border outline-none",
                isDup ? "border-red-500/40" : "border-black/10 dark:border-white/10 focus:border-accent-lineage/50",
              )}
            />
            {listOpen && (
              <ul role="listbox" aria-label="Suggested names"
                className="absolute left-0 right-0 top-full mt-1 z-20 rounded-lg border border-glass-border bg-canvas-elevated shadow-lg py-1 max-h-56 overflow-y-auto">
                {offered.map((o, i) => (
                  <li key={o.key} role="option" aria-selected={i === highlight}
                    onMouseDown={(e) => { e.preventDefault(); pick(o.key) }}
                    className={cn('flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-xs',
                      i === highlight ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]')}>
                    <span className="font-mono text-ink truncate">{o.key}</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-ink-muted truncate max-w-[55%]">
                      {o.recent ? 'You used it recently'
                        : `${o.count.toLocaleString()} other${o.count === 1 ? '' : 's'}${o.examples[0] ? ` · e.g. ${o.examples[0]}` : ''}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <span className="flex-1 text-xs text-ink-muted">New {FIELD_TYPE_META[type].label} item</span>
        )}
        <FieldTypeChip fieldType={shownType} onChange={changeType} />
      </div>

      {isDup && (
        <p className="flex items-center gap-2 text-2xs text-red-500 pl-1">
          “{candidateKey}” already exists.
          {onUpdateExisting && (
            <button type="button" onClick={updateInstead} className="font-semibold text-accent-lineage hover:underline">
              Update it instead
            </button>
          )}
        </p>
      )}

      {/* Row 2: value — typed as text and detected, until a type is picked */}
      <div className="flex items-center gap-2">
        <span className="text-2xs uppercase tracking-wider text-ink-muted w-10 flex-shrink-0">Value</span>
        <div className="flex-1 min-w-0">
          {typeChosen ? (
            <ComposerValueField
              type={type}
              value={draft}
              onChange={setDraft}
              onExpand={() => setModalOpen(true)}
              onEnter={() => submit()}
            />
          ) : (
            <input
              value={text}
              aria-label="Value"
              placeholder={picked?.examples[0] ? `e.g. ${picked.examples[0]}` : 'Enter a value…'}
              onChange={(e) => setText(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) submit() }}
              className="w-full text-sm px-2.5 py-1.5 rounded-md bg-black/[0.03] dark:bg-white/5 border border-black/10 dark:border-white/10 focus:border-accent-lineage/50 outline-none"
            />
          )}
        </div>
      </div>

      {/* What it will read as, before it is added. */}
      {smartish && key.trim() && !isDup && (
        <div className="flex items-center gap-2 pl-1 text-xs min-w-0" aria-live="polite">
          <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide shrink-0', fieldTone('added').chip)}>New</span>
          <span className="font-mono text-ink truncate">{candidateKey}</span>
          <span className="text-ink-secondary truncate">{shortValue(value)}</span>
          {!typeChosen && text.trim() && detected.type !== 'text' && (
            <span className="ml-auto shrink-0 text-[10.5px] text-ink-muted">read as {FIELD_TYPE_META[detected.type].label.toLowerCase()}</span>
          )}
        </div>
      )}

      {/* Row 3: actions */}
      <div className="flex items-center justify-end gap-2 pt-0.5">
        {smartish && onAddMany && (
          <span className="mr-auto text-[10.5px] text-ink-muted hidden sm:inline">Paste several “name: value” lines to add them all</span>
        )}
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <HoverTip label="Add property" detail={smartish ? 'Enter adds it · ⌘↵ adds it and starts another' : undefined} shortcut={smartish ? '↵' : undefined} className="inline-flex">
          <button
            onClick={() => submit()}
            disabled={!canSubmit}
            className={cn(
              "flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all",
              canSubmit
                ? "bg-accent-lineage text-white hover:brightness-110 shadow-sm shadow-accent-lineage/25"
                : "bg-black/[0.03] dark:bg-white/5 text-ink-muted/50 cursor-not-allowed",
            )}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </HoverTip>
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
      <HoverTip label="Open editor (Markdown)" className="inline-flex flex-shrink-0">
        <button
          onClick={onExpand}
          aria-label="Open editor (Markdown)"
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </HoverTip>
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
  /** Several properties at once — one change, so one Undo. */
  addEntries: (entries: Array<[string, unknown]>) => void
  existingKeys: () => string[]
  /** Put a key back as it was read (its value, or gone if it is new). */
  revert: (fullKey: string) => void
  /** Feature it at a glance, or stop. */
  toggleFeatured: (fullKey: string) => void
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

/** The tree pruned to the keys in `keep` (and the folders on the way to them). */
function keepKeys(folders: TreeNode[], leaves: Leaf[], keep: ReadonlyMap<string, unknown>): { folders: TreeNode[]; leaves: Leaf[] } {
  const pruneNode = (node: TreeNode): TreeNode | null => {
    const subFolders = node.folders.map(pruneNode).filter(Boolean) as TreeNode[]
    const subLeaves = node.leaves.filter((l) => keep.has(l.fullKey))
    const own = node.own && keep.has(node.own.fullKey) ? node.own : undefined
    return subFolders.length || subLeaves.length || own ? { ...node, folders: subFolders, leaves: subLeaves, own } : null
  }
  return { folders: folders.map(pruneNode).filter(Boolean) as TreeNode[], leaves: leaves.filter((l) => keep.has(l.fullKey)) }
}

function GroupedObjectRoot({
  value,
  onChange,
  readOnlyKeys,
  readOnly,
  searchable,
  original,
  published,
  startAdding = false,
  suggestions,
  sectionsKey,
  featuredKeys,
  onToggleFeatured,
}: {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  readOnlyKeys?: string[]
  readOnly?: boolean
  searchable?: boolean
  original?: Record<string, unknown>
  published?: Record<string, unknown>
  startAdding?: boolean
  suggestions?: ReadonlyArray<string | PropertySuggestion>
  sectionsKey?: string
  featuredKeys?: readonly string[]
  onToggleFeatured?: (key: string) => void
}) {
  const inline = useContext(InlineModeContext)
  const technical = usePersonaMode() === 'technical'
  const [flat, setFlat] = useState(false)
  const [display, setDisplay] = useState<DisplayMode>('formatted')
  const [editTextMode, setEditTextMode] = useState<EditTextMode>('rich')
  const [query, setQuery] = useState('')
  // `true`, or the name a suggestion starts the form with.
  const [addingRoot, setAddingRoot] = useState<boolean | string>(startAdding)
  const sections = useSectionsOpen(sectionsKey)

  const entries = Object.entries(value)
  const tree = useMemo(() => buildPathTree(entries), [value])
  // What each property's edit did — computed once per edit, handed to rows as plain values so
  // only the rows whose mark changed re-render.
  // Read-only, only what the draft changed is said (nothing is being edited here).
  const { marks, removed, unsavedRemoved } = useMemo(
    () => propertyMarks(value, readOnly ? undefined : original, published), [value, original, published, readOnly])
  // Only what changed: the changed, new and removed properties, nothing else.
  const [changesOnly, setChangesOnly] = useState(false)
  const changeCounts = useMemo(() => {
    let changed = 0, added = 0
    for (const m of marks.values()) { if (m.mark === 'new') added++; else changed++ }
    return { changed, added, removed: removed.length }
  }, [marks, removed])
  const anyChange = marks.size + removed.length > 0
  const featured = useMemo(() => new Set(featuredKeys ?? []), [featuredKeys])

  // Keep `api` identity stable across edits (it reads the latest value/onChange
  // through a ref) so memoized rows don't all re-render when one value changes.
  const liveRef = useRef({ value, onChange, original: published ?? original, onToggleFeatured })
  liveRef.current = { value, onChange, original: published ?? original, onToggleFeatured }
  const api: FlatApi = useMemo(() => ({
    updateValue: (fullKey, v) => liveRef.current.onChange(setKeyValue(liveRef.current.value, fullKey, v)),
    renameLeaf: (fullKey, parentPath, newSegment) =>
      liveRef.current.onChange(renameKey(liveRef.current.value, fullKey, parentPath ? `${parentPath}${PATH_SEP}${newSegment}` : newSegment)),
    deleteKey: (fullKey) => liveRef.current.onChange(deleteKey(liveRef.current.value, fullKey)),
    renameFolder: (oldPath, newPath) => liveRef.current.onChange(renamePrefix(liveRef.current.value, oldPath, newPath)),
    deleteFolder: (path) => liveRef.current.onChange(deletePrefix(liveRef.current.value, path)),
    addEntry: (prefix, name, val) => liveRef.current.onChange(addEntry(liveRef.current.value, prefix, name, val)),
    addEntries: (entries) => liveRef.current.onChange({ ...liveRef.current.value, ...Object.fromEntries(entries) }),
    existingKeys: () => Object.keys(liveRef.current.value),
    // Back as it was published (or, without that, as read): its old value, or — for one added — gone.
    revert: (fullKey) => {
      const { value: v, original: o } = liveRef.current
      if (o && Object.prototype.hasOwnProperty.call(o, fullKey)) liveRef.current.onChange(setKeyValue(v, fullKey, o[fullKey]))
      else liveRef.current.onChange(deleteKey(v, fullKey))
    },
    toggleFeatured: (fullKey) => liveRef.current.onToggleFeatured?.(fullKey),
  }), [])
  const canFeature = !!onToggleFeatured

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    const shown = changesOnly && anyChange ? keepKeys(tree.folders, tree.leaves, marks) : tree
    return q ? pruneTree(shown.folders, shown.leaves, q) : shown
  }, [tree, q, changesOnly, anyChange, marks])
  const shownRemoved = useMemo(
    () => (q ? removed.filter(([k, v]) => k.toLowerCase().includes(q) || searchableText(v).includes(q)) : removed),
    [removed, q],
  )
  const removedKeys = useMemo(() => removed.map(([k]) => k), [removed])

  const empty = entries.length === 0
  const readsFormatted = readOnly || inline
  const peers = useMemo<PropertySuggestion[]>(
    () => (suggestions ?? []).map((sg) => (typeof sg === 'string' ? { key: sg, count: 0, examples: [] } : sg)),
    [suggestions],
  )
  const offered = useMemo(
    () => (readOnly ? [] : peers.map((p) => p.key).filter((k) => !Object.prototype.hasOwnProperty.call(value, k)).slice(0, 5)),
    [peers, value, readOnly],
  )

  const viewMenu = (
    <ViewMenu
      flat={flat}
      onFlat={setFlat}
      // The text as stored is the Technical view's to ask for.
      text={!technical ? undefined : readsFormatted
        ? { value: display === 'source' ? 'source' : 'formatted', onChange: (v) => setDisplay(v === 'source' ? 'source' : 'formatted'), labels: ['Formatted', 'Markdown'] }
        : { value: editTextMode === 'source' ? 'source' : 'formatted', onChange: (v) => setEditTextMode(v === 'source' ? 'source' : 'rich'), labels: ['Rich', 'Source'] }}
    />
  )

  // Sections: what sits in no folder first (General), then each top-level folder.
  const general = visible.leaves
  const sectionCount = visible.folders.length + (general.length > 0 ? 1 : 0)
  const generalAt = general.length > 0 ? 0 : -1

  return (
    <DisplayModeContext.Provider value={readsFormatted ? display : 'source'}>
    <EditTextModeContext.Provider value={editTextMode}>
    <div>
      {/* Toolbar: search on its own line; Changes only and how the list is shown beside or under it */}
      <div className="mb-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5">
          {searchable ? (
            <div className="flex-1 min-w-0">
              <SearchBox
                query={query}
                onChange={setQuery}
                placeholder={`Search ${entries.length} ${entries.length === 1 ? 'property' : 'properties'}…`}
                className="mb-0"
              />
            </div>
          ) : <span className="flex-1" />}
          {!anyChange && viewMenu}
        </div>
        {anyChange && (
          <div className="flex items-center justify-between gap-1.5">
            <HoverTip label={changesOnly ? 'Show every property' : 'Show only the properties that changed'} className="inline-flex">
              <button type="button" aria-pressed={changesOnly} onClick={() => setChangesOnly((v) => !v)}
                className={cn('inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[11px] font-semibold flex-shrink-0 transition-colors',
                  changesOnly ? 'bg-accent-lineage/10 text-accent-lineage ring-1 ring-accent-lineage/30' : 'text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5')}>
                Changes only
                <FieldCountChips summary={changeCounts} />
              </button>
            </HoverTip>
            {viewMenu}
          </div>
        )}
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
            featured={featured}
            onToggleFeatured={onToggleFeatured}
          />
          <RemovedRows rows={shownRemoved} onRestore={readOnly ? undefined : api.revert} unsaved={unsavedRemoved} />
        </>
      ) : empty && shownRemoved.length === 0 ? (
        readOnly ? (
          <div className="text-xs text-ink-muted px-2 py-2">No properties</div>
        ) : (
          <RootAdder api={api} adding={addingRoot} setAdding={setAddingRoot} suggestions={offered} peers={peers} />
        )
      ) : (
        <div className="space-y-2">
          {general.length > 0 && (
            <SectionCard
              name={sectionCount > 1 ? 'General' : undefined}
              count={general.length}
              changes={sectionCount > 1 ? changesIn(general.map((l) => l.fullKey), marks, removedKeys.filter((k) => !k.includes(PATH_SEP))) : undefined}
              open={!!q || sections.isOpen(GENERAL, generalAt, sectionCount)}
              onToggle={() => sections.setOpen(GENERAL, !sections.isOpen(GENERAL, generalAt, sectionCount))}
              forceExpand={!!q}
            >
              {general.map((leaf) => (
                <LeafRow key={leaf.fullKey} leaf={leaf} parentPath="" depth={0} readOnly={readOnly} query={q} api={api}
                  mark={marks.get(leaf.fullKey)?.mark} was={marks.get(leaf.fullKey)?.was} unsaved={marks.get(leaf.fullKey)?.unsaved}
                  featured={featured.has(leaf.fullKey)} canFeature={canFeature} />
              ))}
            </SectionCard>
          )}
          {visible.folders.map((node, i) => {
            const at = i + (general.length > 0 ? 1 : 0)
            const open = sections.isOpen(node.path, at, sectionCount)
            return (
              <FolderGroup key={node.path} node={node} depth={0} readOnly={readOnly} query={q} forceExpand={!!q} api={api}
                marks={marks} removedKeys={removedKeys} featured={featured} canFeature={canFeature}
                open={open} onOpenChange={(next) => sections.setOpen(node.path, next)} />
            )
          })}
          <RemovedRows rows={shownRemoved} onRestore={readOnly ? undefined : api.revert} unsaved={unsavedRemoved} />
          {q && visible.folders.length === 0 && visible.leaves.length === 0 && shownRemoved.length === 0 && (
            <div className="text-xs text-ink-muted px-2 py-3">No properties match “{query.trim()}”.</div>
          )}
          {!readOnly && !q && (
            <RootAdder api={api} adding={addingRoot} setAdding={setAddingRoot} suggestions={offered} peers={peers} />
          )}
        </div>
      )}
    </div>
    </EditTextModeContext.Provider>
    </DisplayModeContext.Provider>
  )
}

/** The section that holds what sits in no folder. */
const GENERAL = '\u0000general'

/**
 * Which sections of a property list are open. Remembered for the kind of entity when the list is
 * given `rememberAs` (with the drawer's own sections), else for as long as the list is shown. A list
 * of three sections or fewer starts with every one open; a longer one with its first two.
 */
function useSectionsOpen(rememberAs: string | undefined) {
  const stored = usePreferencesStore((s) => (rememberAs ? s.drawerSectionsCollapsed : null))
  const setStored = usePreferencesStore((s) => s.setDrawerSectionCollapsed)
  const [local, setLocal] = useState<Record<string, boolean>>({})
  const keyOf = (path: string) => `props:${rememberAs}:${path}`
  const isOpen = (path: string, index: number, total: number) => {
    const collapsed = stored ? stored[keyOf(path)] : local[path]
    return collapsed === undefined ? total <= 3 || index < 2 : !collapsed
  }
  const setOpen = (path: string, open: boolean) => {
    if (rememberAs) setStored(keyOf(path), !open)
    else setLocal((m) => ({ ...m, [path]: !open }))
  }
  return { isOpen, setOpen }
}

/** What changed among `keys` (and how many under it were removed), for a section's chips. */
function changesIn(keys: readonly string[], marks: PropertyMarks['marks'], removedUnder: readonly string[]) {
  let changed = 0, added = 0
  for (const k of keys) {
    const m = marks.get(k)
    if (m?.mark === 'new') added++
    else if (m) changed++
  }
  return { changed, added, removed: removedUnder.length }
}

function leafKeys(node: TreeNode): string[] {
  const out = node.own ? [node.own.fullKey] : []
  for (const l of node.leaves) out.push(l.fullKey)
  for (const f of node.folders) out.push(...leafKeys(f))
  return out
}

/** How the list is shown: in sections or flat, and — in the Technical view — its text formatted
 *  or as stored. One small menu, so the data keeps the room. */
function ViewMenu({ flat, onFlat, text }: {
  flat: boolean
  onFlat: (flat: boolean) => void
  text?: { value: 'formatted' | 'source'; onChange: (v: 'formatted' | 'source') => void; labels: [string, string] }
}) {
  const item = 'flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-lg text-xs text-ink cursor-pointer outline-none data-[highlighted]:bg-black/[0.04] dark:data-[highlighted]:bg-white/[0.06]'
  const check = <DropdownMenu.ItemIndicator className="ml-auto"><Check className="w-3.5 h-3.5 text-accent-lineage" /></DropdownMenu.ItemIndicator>
  const heading = 'px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted'
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="View options"
          className="inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/5 flex-shrink-0 transition-colors">
          <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
          View
          <ChevronDown className="w-3 h-3" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4}
          className="z-[9999] w-52 p-1 bg-canvas-elevated border border-glass-border rounded-xl shadow-xl">
          <DropdownMenu.Label className={heading}>Layout</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={flat ? 'flat' : 'sections'} onValueChange={(v) => onFlat(v === 'flat')}>
            <DropdownMenu.RadioItem value="sections" className={item}>
              <span><span className="block">Sections</span><span className="block text-2xs text-ink-muted">Grouped by folder</span></span>{check}
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="flat" className={item}>
              <span><span className="block">Flat</span><span className="block text-2xs text-ink-muted">Every key in full</span></span>{check}
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          {text && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-black/[0.06] dark:bg-white/[0.08]" />
              <DropdownMenu.Label className={heading}>Text</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={text.value} onValueChange={(v) => text.onChange(v as 'formatted' | 'source')}>
                <DropdownMenu.RadioItem value="formatted" className={item}>{text.labels[0]}{check}</DropdownMenu.RadioItem>
                <DropdownMenu.RadioItem value="source" className={item}>{text.labels[1]}{check}</DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** A section of the list: its name, how many properties and what changed in it, and its rows
 *  divided by hairlines. Without a name (the only section) it is just the rows. */
function SectionCard({ name, nameSlot, count, changes, open, onToggle, forceExpand, actions, footer, children }: {
  name?: string
  /** In place of the name — its rename field. */
  nameSlot?: ReactNode
  count: number
  changes?: { changed: number; added: number; removed: number }
  open: boolean
  onToggle: () => void
  forceExpand?: boolean
  actions?: ReactNode
  /** Below the rows: adding one here. */
  footer?: ReactNode
  children: ReactNode
}) {
  const headed = name !== undefined
  return (
    <section aria-label={name ?? 'Properties'}
      className="group/section rounded-xl border border-glass-border bg-black/[0.012] dark:bg-white/[0.02]">
      {headed && (
        <div className={cn('flex items-center gap-1.5 h-9 pl-1.5 pr-1.5', open && 'border-b border-black/[0.05] dark:border-white/[0.06]')}>
          <button type="button" onClick={onToggle} disabled={forceExpand}
            aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}
            className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 flex-shrink-0">
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <div className="min-w-0 flex items-center">
            {nameSlot ?? <span className="text-[12px] font-semibold text-ink truncate">{name}</span>}
          </div>
          <span className="text-2xs text-ink-muted tabular-nums flex-shrink-0">
            {count} {count === 1 ? 'property' : 'properties'}
          </span>
          {changes && <FieldCountChips summary={changes} className="flex-shrink-0" />}
          <span className="flex-1" />
          {actions && (
            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 transition-opacity">
              {actions}
            </div>
          )}
        </div>
      )}
      {(open || !headed) && <div className="px-1.5 py-0.5"><Rows>{children}</Rows>{footer}</div>}
    </section>
  )
}

/** Rows divided by hairlines. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">{children}</div>
}

function RootAdder({ api, adding, setAdding, suggestions = [], peers = [] }: {
  api: FlatApi
  /** `true`, or the name to start the form with. */
  adding: boolean | string
  setAdding: (b: boolean | string) => void
  /** Names worth adding, one click each. */
  suggestions?: string[]
  /** What others of this type carry, offered as the name is typed. */
  peers?: readonly PropertySuggestion[]
}) {
  return adding ? (
    <PropertyComposer
      key={typeof adding === 'string' ? adding : ''}
      initialKey={typeof adding === 'string' ? adding : undefined}
      onAdd={(name, val) => api.addEntry('', name, val)}
      onCancel={() => setAdding(false)}
      existingKeys={api.existingKeys()}
      variant="object"
      suggestions={peers}
      onAddMany={(entries) => api.addEntries(entries)}
      onUpdateExisting={(k, v) => api.updateValue(k, v)}
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

/** Properties removed — struck through, each with Restore while editing; a dashed dot when the
 *  removal is not saved yet, a solid one when it is saved in the draft. */
function RemovedRows({ rows, onRestore, unsaved }: {
  rows: [string, unknown][]
  onRestore?: (key: string) => void
  unsaved?: ReadonlySet<string>
}) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1 pt-1">
      {rows.map(([key, was]) => (
        <div key={key} className={cn('relative flex items-center gap-1.5 py-1.5 pl-5 pr-1 rounded-lg bg-rose-500/[0.04] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-rose-500',
          unsaved && !unsaved.has(key) && 'before:opacity-60')}>
          <span className="basis-[36%] min-w-[112px] max-w-[200px] flex-shrink-0 text-xs font-mono text-ink-muted line-through break-all line-clamp-2">{key}</span>
          <span className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide bg-rose-500/12 text-rose-700 dark:text-rose-300 flex-shrink-0">
            <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', STATE_DOT[!unsaved || unsaved.has(key) ? 'unsaved' : 'saved'])} />
            Removed
            <span className="sr-only">{!unsaved || unsaved.has(key) ? ', not saved yet' : ', saved in this draft'}</span>
          </span>
          <span className="flex-1 min-w-0 text-xs text-ink-muted line-through truncate">{shortValue(was)}</span>
          {onRestore && <button
            onClick={() => onRestore(key)}
            className="flex items-center gap-1 px-2 h-6 rounded-md text-2xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 flex-shrink-0"
          >
            <Undo2 className="w-3 h-3" aria-hidden />
            Restore
          </button>}
        </div>
      ))}
    </div>
  )
}

const LeafRow = memo(function LeafRow({
  leaf,
  parentPath,
  depth,
  readOnly,
  query,
  api,
  mark,
  was,
  unsaved,
  featured,
  canFeature,
}: {
  leaf: Leaf
  parentPath: string
  depth: number
  readOnly?: boolean
  query: string
  api: FlatApi
  mark?: ChangeMark
  was?: unknown
  unsaved?: boolean
  /** Shown at a glance. */
  featured?: boolean
  /** It can be featured at a glance (or stop being) from here. */
  canFeature?: boolean
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
      unsaved={unsaved}
      onRevert={mark && !readOnly ? () => api.revert(leaf.fullKey) : undefined}
      featured={featured}
      onToggleFeatured={canFeature ? () => api.toggleFeatured(leaf.fullKey) : undefined}
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
  prev.was === next.was &&
  prev.unsaved === next.unsaved &&
  prev.featured === next.featured &&
  prev.canFeature === next.canFeature)

// ============================================
// FolderGroup — a folder: a section card at the top level, a sub-heading inside one
// ============================================

function FolderGroup({
  node,
  depth,
  readOnly,
  query,
  forceExpand,
  api,
  marks,
  removedKeys = [],
  featured,
  canFeature,
  open: openProp,
  onOpenChange,
}: {
  node: TreeNode
  depth: number
  readOnly?: boolean
  query: string
  forceExpand?: boolean
  api: FlatApi
  marks?: PropertyMarks['marks']
  /** Every key removed (the folder counts its own). */
  removedKeys?: readonly string[]
  featured?: ReadonlySet<string>
  canFeature?: boolean
  /** Whether it is open, when the list keeps that (top-level sections). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  // A folder inside a section waits to be opened.
  const [ownOpen, setOwnOpen] = useState(depth < 1)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(node.name)
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => { setNameDraft(node.name) }, [node.name])

  const isOpen = forceExpand || (openProp ?? ownOpen)
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setOwnOpen(next))
  const parentPath = node.path.includes(PATH_SEP) ? node.path.slice(0, node.path.lastIndexOf(PATH_SEP)) : ''
  const count = countLeaves(node)
  // What changed inside — said on the folder, so a closed one still shows its changes.
  const changes = useMemo(
    () => changesIn(leafKeys(node), marks ?? new Map(), removedKeys.filter((k) => k.startsWith(node.path + PATH_SEP))),
    [node, marks, removedKeys],
  )

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

  const top = depth === 0
  const name = readOnly ? (
    <span className={cn('truncate', top ? 'text-[12px] font-semibold text-ink' : 'text-[11.5px] font-semibold text-ink-secondary')}>
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
    <HoverTip label="Rename folder" detail={`Renames every property in ${node.path}`} className="inline-flex min-w-0">
      <button
        onClick={() => { nameCancelled.current = false; setEditingName(true) }}
        aria-label={`Rename folder ${node.name}`}
        className={cn('truncate text-left max-w-full hover:text-accent-lineage',
          top ? 'text-[12px] font-semibold text-ink' : 'text-[11.5px] font-semibold text-ink-secondary')}
      >
        <HighlightedText text={node.name} query={query} />
      </button>
    </HoverTip>
  )

  const btn = 'w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10'
  const actions = readOnly ? null : (
    <>
      <HoverTip label="Add property in this folder" className="inline-flex">
        <button onClick={() => { setAdding(true); setOpen(true) }} aria-label="Add property in this folder" className={btn}>
          <FolderPlus className="w-3 h-3" />
        </button>
      </HoverTip>
      {confirmDelete ? (
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => api.deleteFolder(node.path)}
            className="px-1.5 h-6 flex items-center justify-center rounded text-2xs font-semibold text-red-500 bg-red-500/10 hover:bg-red-500/20"
          >
            Delete {count}?
          </button>
          <HoverTip label="Keep folder" className="inline-flex">
            <button onClick={() => setConfirmDelete(false)} aria-label="Keep folder" className={btn}>
              <XIcon className="w-3 h-3" />
            </button>
          </HoverTip>
        </div>
      ) : (
        <HoverTip label="Delete folder and all its properties" className="inline-flex">
          <button onClick={() => setConfirmDelete(true)} aria-label="Delete folder and all its properties"
            className="w-6 h-6 flex items-center justify-center rounded text-ink-muted hover:text-red-500 hover:bg-red-500/10">
            <Trash2 className="w-3 h-3" />
          </button>
        </HoverTip>
      )}
    </>
  )

  const rows = (
    <>
      {node.own && (
        <LeafRow leaf={node.own} parentPath={parentPath} depth={depth + 1} readOnly={readOnly} query={query} api={api}
          mark={marks?.get(node.own.fullKey)?.mark} was={marks?.get(node.own.fullKey)?.was} unsaved={marks?.get(node.own.fullKey)?.unsaved}
          featured={featured?.has(node.own.fullKey)} canFeature={canFeature} />
      )}
      {node.folders.map((child) => (
        <FolderGroup key={child.path} node={child} depth={depth + 1} readOnly={readOnly} query={query} forceExpand={forceExpand} api={api}
          marks={marks} removedKeys={removedKeys} featured={featured} canFeature={canFeature} />
      ))}
      {node.leaves.map((leaf) => (
        <LeafRow key={leaf.fullKey} leaf={leaf} parentPath={node.path} depth={depth + 1} readOnly={readOnly} query={query} api={api}
          mark={marks?.get(leaf.fullKey)?.mark} was={marks?.get(leaf.fullKey)?.was} unsaved={marks?.get(leaf.fullKey)?.unsaved}
          featured={featured?.has(leaf.fullKey)} canFeature={canFeature} />
      ))}
    </>
  )
  const adder = readOnly ? null : adding ? (
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
      className="flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors my-1.5 ml-1"
    >
      <Plus className="w-3.5 h-3.5" />
      Add property
    </button>
  )
  const anyChange = changes.changed + changes.added + changes.removed > 0

  if (top) {
    return (
      <SectionCard name={node.name} nameSlot={name} count={count} changes={anyChange ? changes : undefined}
        open={isOpen} onToggle={() => setOpen(!isOpen)} forceExpand={forceExpand} actions={actions} footer={adder}>
        {rows}
      </SectionCard>
    )
  }

  // Inside a section: a sub-heading, its rows indented under it.
  return (
    <div role="group" aria-label={node.name} className="group/folder">
      <div className="flex items-center gap-1.5 h-8 pr-1">
        <button type="button" onClick={() => setOpen(!isOpen)} disabled={forceExpand}
          aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen}
          className="w-5 h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink flex-shrink-0">
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="min-w-0 flex items-center">{name}</div>
        <span className="text-2xs text-ink-muted tabular-nums flex-shrink-0">{count}</span>
        {anyChange && <FieldCountChips summary={changes} className="flex-shrink-0" />}
        <span className="flex-1" />
        {actions && (
          <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 transition-opacity">
            {actions}
          </div>
        )}
      </div>
      {isOpen && (
        <div className="ml-2.5 pl-2.5 border-l border-black/[0.06] dark:border-white/[0.08] mb-1">
          <Rows>{rows}</Rows>
          {adder}
        </div>
      )}
    </div>
  )
}

export default PropertyEditor
