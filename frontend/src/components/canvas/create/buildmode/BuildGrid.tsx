/**
 * BuildGrid — the virtualized "Grid" tab body of the Build panel (Task 7).
 * The bulk-authoring spreadsheet: hundreds/thousands of rows edited as a
 * table (Name / Type / Parent / Description), windowed with
 * `@tanstack/react-virtual` so only the rows currently in view are ever
 * mounted (mirrors `LayerColumn.tsx`'s virtualization pattern).
 *
 * Like `BuildOutline`, `rows` here is BuildPanel's already-computed
 * `validateBuildRows(rows, ctx)` view (recomputed on every render from the
 * live store) — not a second validation pass, so status/type chips match the
 * panel's footer summary exactly. Validation can synthesize new rows
 * (auto-inserted missing ancestor levels); those render read-only (dimmed,
 * no inputs, not selectable) since there's no store row id to mutate.
 *
 * Every edit calls `buildRowsStore.updateRow`/`addSibling`/`addChild`/
 * `removeRow` directly — no local draft state. Duplicate-row clones the
 * row's WHOLE subtree in one `duplicateRowSubtree` store action (fresh ids,
 * re-threaded parentIds, inserted right after the original's subtree).
 *
 * Fill-down: shift-clicking a row's selection checkbox selects the visually
 * contiguous range (`computeRangeIds`); with 2+ rows selected, a bar also
 * offers setting Type/Parent/Description on every selected row in one
 * action. A single selected row (or more) exposes a delete-selected action;
 * a header checkbox selects/clears every row. Paste-into-cell: pasting
 * multi-line clipboard text into a Name/Description cell fills each
 * subsequent row (`computeDownIds`) instead of collapsing into one cell.
 *
 * Layer column: each row's Layer cell defaults to the auto-by-type target —
 * derived from the view's own layers (`useLayers()`) via the same
 * `buildTypeLayerMap` the resolver (`resolveRowLayer.ts`) uses — and can be
 * overridden per row (`buildRowsStore.setRowLayer`); clearing the override
 * reverts to auto-by-type. Ontology-agnostic: no type/layer names here.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useViewEntityTypes } from '@/hooks/useViewSchema'
import { useLayers } from '@/store/referenceModelStore'
import type { EntityTypeSchema } from '@/types/schema'
import type { BuildRow } from './buildRow'
import { useBuildRowsStore } from './buildRowsStore'
import { buildTypeLayerMap } from './resolveRowLayer'
import { computeRangeIds, computeDownIds, descendantIds } from './buildGridSelection'

export interface BuildGridProps {
  /** Validated rows (BuildPanel's `validateBuildRows(rows, ctx)`) — live type inference + status. */
  rows: BuildRow[]
  typeById: Map<string, EntityTypeSchema>
}

const ROW_HEIGHT = 44

const STATUS_BADGE: Record<BuildRow['status'], { icon: string; cls: string } | null> = {
  valid: null,
  fixed: { icon: 'Wand2', cls: 'text-amber-500' },
  error: { icon: 'AlertTriangle', cls: 'text-rose-500' },
}

/** The ontology-colored icon chip — matches BuildOutline's/BuildPanel's TypeChip. */
function TypeChip({ type }: { type?: EntityTypeSchema }) {
  return (
    <span
      className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${type?.visual?.color}20`, color: type?.visual?.color }}
    >
      <DynamicIcon name={type?.visual?.icon ?? 'Box'} className="w-3 h-3" />
    </span>
  )
}

/** Closes an open popover on an outside mousedown. */
function useOutsideDismiss(ref: React.RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onDismiss])
}

function TypePickerPopover({
  entityTypes, selectedId, onPick, onClose,
}: {
  entityTypes: EntityTypeSchema[]
  selectedId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  useOutsideDismiss(ref, onClose)

  const filtered = useMemo(() => {
    if (!q.trim()) return entityTypes
    const s = q.toLowerCase()
    return entityTypes.filter((t) => t.name.toLowerCase().includes(s) || t.id.toLowerCase().includes(s))
  }, [entityTypes, q])

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-30 w-56 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-1.5 border-b border-glass-border">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search types…"
          className="w-full px-2 py-1 text-xs bg-transparent focus:outline-none text-ink placeholder:text-ink-muted/50"
        />
      </div>
      <div className="max-h-48 overflow-y-auto custom-scrollbar p-1 space-y-0.5">
        {filtered.length === 0 && <div className="text-center py-3 text-[11px] text-ink-muted">No matching types.</div>}
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors',
              t.id === selectedId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <TypeChip type={t} />
            <span className="flex-1 min-w-0 text-xs text-ink truncate">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ParentPickerPopover({
  options, typeById, selectedId, onPick, onClear, onClose,
}: {
  options: BuildRow[]
  typeById: Map<string, EntityTypeSchema>
  selectedId: string | null
  onPick: (id: string) => void
  onClear: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  useOutsideDismiss(ref, onClose)

  const filtered = useMemo(() => {
    if (!q.trim()) return options
    const s = q.toLowerCase()
    return options.filter((r) => (r.name || '(unnamed)').toLowerCase().includes(s))
  }, [options, q])

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-30 w-56 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-1.5 border-b border-glass-border">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rows…"
          className="w-full px-2 py-1 text-xs bg-transparent focus:outline-none text-ink placeholder:text-ink-muted/50"
        />
      </div>
      <div className="max-h-48 overflow-y-auto custom-scrollbar p-1 space-y-0.5">
        <button
          type="button"
          onClick={onClear}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-xs italic transition-colors',
            selectedId == null ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30 text-ink' : 'text-ink-muted hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          Top level
        </button>
        {filtered.length === 0 && <div className="text-center py-3 text-[11px] text-ink-muted">No matching rows.</div>}
        {filtered.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors',
              r.id === selectedId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <TypeChip type={r.typeId ? typeById.get(r.typeId) : undefined} />
            <span className="flex-1 min-w-0 text-xs text-ink truncate">{r.name || '(unnamed)'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Picker for the Layer override column — options are the view's OWN layers
 *  (never hard-coded names); the top entry clears the override back to the
 *  auto-by-type target. */
function LayerPickerPopover({
  layers, selectedId, autoLabel, onPick, onClear, onClose,
}: {
  layers: { id: string; name: string }[]
  selectedId: string | null
  autoLabel: string
  onPick: (id: string) => void
  onClear: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  useOutsideDismiss(ref, onClose)

  const filtered = useMemo(() => {
    if (!q.trim()) return layers
    const s = q.toLowerCase()
    return layers.filter((l) => l.name.toLowerCase().includes(s))
  }, [layers, q])

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-30 w-56 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-1.5 border-b border-glass-border">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search layers…"
          className="w-full px-2 py-1 text-xs bg-transparent focus:outline-none text-ink placeholder:text-ink-muted/50"
        />
      </div>
      <div className="max-h-48 overflow-y-auto custom-scrollbar p-1 space-y-0.5">
        <button
          type="button"
          onClick={onClear}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left text-xs italic transition-colors',
            selectedId == null ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30 text-ink' : 'text-ink-muted hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          Auto ({autoLabel})
        </button>
        {filtered.length === 0 && <div className="text-center py-3 text-[11px] text-ink-muted">No matching layers.</div>}
        {filtered.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors',
              l.id === selectedId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <span className="flex-1 min-w-0 text-xs text-ink truncate">{l.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Splits pasted clipboard text into lines when it looks like a multi-row spreadsheet paste. */
function pasteLines(text: string): string[] | null {
  const lines = text.split(/\r\n|\r|\n/)
  return lines.length > 1 ? lines : null
}

interface BuildGridRowProps {
  row: BuildRow
  isSynthetic: boolean
  type?: EntityTypeSchema
  typeById: Map<string, EntityTypeSchema>
  entityTypes: EntityTypeSchema[]
  rawRows: BuildRow[]
  /** The view's own layers, for the Layer override picker's options (by name). */
  layers: { id: string; name: string }[]
  /** `typeId → layerId` auto-by-type map (`buildTypeLayerMap`), for the Layer cell's default. */
  typeLayerMap: Map<string, string>
  selected: boolean
  onToggleSelect: (shiftKey: boolean) => void
  onUpdate: (patch: Partial<BuildRow>) => void
  onSetLayer: (layerId: string | undefined) => void
  onPasteDown: (field: 'name' | 'description', lines: string[]) => void
  onAddSibling: () => void
  onAddChild: () => void
  onDuplicate: () => void
  onRemove: () => void
}

function BuildGridRow({
  row, isSynthetic, type, typeById, entityTypes, rawRows, layers, typeLayerMap, selected,
  onToggleSelect, onUpdate, onSetLayer, onPasteDown, onAddSibling, onAddChild, onDuplicate, onRemove,
}: BuildGridRowProps) {
  const [openPicker, setOpenPicker] = useState<'type' | 'parent' | 'layer' | null>(null)
  const shiftPressedRef = useRef(false)
  const badge = STATUS_BADGE[row.status]
  const title = row.status === 'error'
    ? row.issues.map((i) => i.message).join(' ')
    : row.status === 'fixed'
      ? row.fixes.map((f) => f.note).join(' ')
      : undefined
  const parentRow = row.parentId != null ? rawRows.find((r) => r.id === row.parentId) : undefined

  const parentOptions = useMemo(() => {
    if (isSynthetic) return []
    const excluded = descendantIds(rawRows, row.id)
    excluded.add(row.id)
    return rawRows.filter((r) => !excluded.has(r.id))
  }, [rawRows, row.id, isSynthetic])

  // Layer cell: auto-by-type target from the SAME typeId→layerId map the
  // resolver uses, overridden by row.layerId when set (Task 2).
  const layerNameById = useMemo(() => new Map(layers.map((l) => [l.id, l.name])), [layers])
  const autoLayerId = row.typeId ? typeLayerMap.get(row.typeId.toLowerCase()) : undefined
  const autoLayerName = autoLayerId ? layerNameById.get(autoLayerId) : undefined
  const effectiveLayerId = row.layerId ?? autoLayerId
  const effectiveLayerName = effectiveLayerId ? layerNameById.get(effectiveLayerId) : undefined

  const handlePaste = (field: 'name' | 'description') => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const lines = pasteLines(e.clipboardData.getData('text/plain'))
    if (!lines) return
    e.preventDefault()
    onPasteDown(field, lines)
  }

  return (
    <div
      title={title}
      className={cn(
        'group/row flex items-center gap-2 h-full px-3 border-b border-glass-border/50',
        isSynthetic ? 'opacity-60' : 'hover:bg-black/5 dark:hover:bg-white/5',
        selected && 'bg-accent-lineage/10',
      )}
    >
      <span className="w-5 flex-shrink-0 flex items-center justify-center">
        {!isSynthetic && (
          <input
            type="checkbox"
            checked={selected}
            onMouseDown={(e) => { shiftPressedRef.current = e.shiftKey }}
            onChange={() => onToggleSelect(shiftPressedRef.current)}
            aria-label={`Select ${row.name || 'row'}`}
            className="w-3.5 h-3.5 accent-accent-lineage"
          />
        )}
      </span>

      <div className="flex-[2] min-w-0 flex items-center gap-1.5" style={{ paddingLeft: row.depth * 16 }}>
        <TypeChip type={type} />
        {isSynthetic ? (
          <span className="flex-1 min-w-0 text-sm italic text-ink-muted truncate">
            {row.name} <span className="text-[10px] not-italic">(auto)</span>
          </span>
        ) : (
          <input
            value={row.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            onPaste={handlePaste('name')}
            placeholder="Name…"
            className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none border-b border-transparent focus:border-accent-lineage/40"
          />
        )}
      </div>

      <div className="w-32 flex-shrink-0 relative">
        <button
          type="button"
          disabled={isSynthetic}
          onClick={() => setOpenPicker('type')}
          className="w-full flex items-center px-1.5 py-1 rounded text-[11px] text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 truncate disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent text-left"
        >
          <span className="truncate">{type?.name ?? row.typeId ?? 'Choose…'}</span>
        </button>
        {openPicker === 'type' && (
          <TypePickerPopover
            entityTypes={entityTypes}
            selectedId={row.typeId}
            onPick={(id) => { onUpdate({ typeId: id }); setOpenPicker(null) }}
            onClose={() => setOpenPicker(null)}
          />
        )}
      </div>

      <div className="w-32 flex-shrink-0 relative">
        <button
          type="button"
          disabled={isSynthetic}
          onClick={() => setOpenPicker('parent')}
          className="w-full flex items-center px-1.5 py-1 rounded text-[11px] text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 truncate disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent text-left"
        >
          <span className="truncate">{parentRow ? (parentRow.name || '(unnamed)') : row.parentId ? row.parentId : '(top level)'}</span>
        </button>
        {openPicker === 'parent' && (
          <ParentPickerPopover
            options={parentOptions}
            typeById={typeById}
            selectedId={row.parentId}
            onPick={(id) => { onUpdate({ parentId: id }); setOpenPicker(null) }}
            onClear={() => { onUpdate({ parentId: null }); setOpenPicker(null) }}
            onClose={() => setOpenPicker(null)}
          />
        )}
      </div>

      <div className="w-28 flex-shrink-0 relative">
        <button
          type="button"
          disabled={isSynthetic}
          onClick={() => setOpenPicker('layer')}
          aria-label={`Layer for ${row.name || 'row'}`}
          className="w-full flex items-center px-1.5 py-1 rounded text-[11px] text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 truncate disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent text-left"
        >
          <span className="truncate">{effectiveLayerName ?? '—'}</span>
        </button>
        {openPicker === 'layer' && (
          <LayerPickerPopover
            layers={layers}
            selectedId={row.layerId ?? null}
            autoLabel={autoLayerName ?? '—'}
            onPick={(id) => { onSetLayer(id); setOpenPicker(null) }}
            onClear={() => { onSetLayer(undefined); setOpenPicker(null) }}
            onClose={() => setOpenPicker(null)}
          />
        )}
      </div>

      <div className="flex-[2] min-w-0">
        {isSynthetic ? (
          <span className="block text-xs text-ink-muted/60 truncate">—</span>
        ) : (
          <input
            value={row.description ?? ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
            onPaste={handlePaste('description')}
            placeholder="Description…"
            className="w-full bg-transparent text-xs text-ink-muted placeholder:text-ink-muted/40 focus:outline-none border-b border-transparent focus:border-accent-lineage/40"
          />
        )}
      </div>

      <span className="w-4 flex-shrink-0 flex items-center justify-center">
        {badge && <DynamicIcon name={badge.icon} className={cn('w-3.5 h-3.5', badge.cls)} />}
      </span>

      <div className="flex items-center gap-0.5 flex-shrink-0 w-[92px] justify-end opacity-0 group-hover/row:opacity-100 transition-opacity">
        {!isSynthetic && (
          <>
            <button type="button" onClick={onAddChild} title="Add a child row" aria-label="Add a child row" className="p-1 rounded text-ink-muted hover:text-accent-lineage hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <DynamicIcon name="CornerDownRight" className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={onDuplicate} title="Duplicate row" aria-label="Duplicate row" className="p-1 rounded text-ink-muted hover:text-accent-lineage hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <DynamicIcon name="Copy" className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={onAddSibling} title="Add a row below" aria-label="Add a row below" className="p-1 rounded text-ink-muted hover:text-accent-lineage hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <DynamicIcon name="Plus" className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={onRemove} title="Remove" aria-label="Remove" className="p-1 rounded text-ink-muted hover:text-rose-500 hover:bg-black/10 dark:hover:bg-white/10 transition-colors">
              <DynamicIcon name="X" className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function FillDownBar({
  count, entityTypes, typeById, rawRows, selectedIds, onApply, onDelete, onClear,
}: {
  count: number
  entityTypes: EntityTypeSchema[]
  typeById: Map<string, EntityTypeSchema>
  rawRows: BuildRow[]
  selectedIds: Set<string>
  onApply: (patch: Partial<BuildRow>) => void
  onDelete: () => void
  onClear: () => void
}) {
  const [openPicker, setOpenPicker] = useState<'type' | 'parent' | null>(null)
  const [description, setDescription] = useState('')

  const parentOptions = useMemo(() => {
    const excluded = new Set(selectedIds)
    selectedIds.forEach((id) => descendantIds(rawRows, id).forEach((d) => excluded.add(d)))
    return rawRows.filter((r) => !excluded.has(r.id))
  }, [rawRows, selectedIds])

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-glass-border bg-accent-lineage/5">
      <span className="text-xs font-medium text-ink">{count} selected</span>

      {/* Fill-down (Type/Parent/Description on every selected row) only makes
          sense once there's more than one row to fill down INTO. */}
      {count >= 2 && (
        <>
          <span className="text-[11px] text-ink-muted">Fill down:</span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenPicker(openPicker === 'type' ? null : 'type')}
              className="px-2 py-1 rounded-lg text-[11px] font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
            >
              Type…
            </button>
            {openPicker === 'type' && (
              <TypePickerPopover
                entityTypes={entityTypes}
                selectedId={null}
                onPick={(id) => { onApply({ typeId: id }); setOpenPicker(null) }}
                onClose={() => setOpenPicker(null)}
              />
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenPicker(openPicker === 'parent' ? null : 'parent')}
              className="px-2 py-1 rounded-lg text-[11px] font-medium bg-black/5 dark:bg-white/10 text-ink hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
            >
              Parent…
            </button>
            {openPicker === 'parent' && (
              <ParentPickerPopover
                options={parentOptions}
                typeById={typeById}
                selectedId={null}
                onPick={(id) => { onApply({ parentId: id }); setOpenPicker(null) }}
                onClear={() => { onApply({ parentId: null }); setOpenPicker(null) }}
                onClose={() => setOpenPicker(null)}
              />
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); onApply({ description }); setDescription('') }}
            className="flex items-center gap-1"
          >
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description…"
              className="w-40 px-2 py-1 rounded-lg text-[11px] bg-black/5 dark:bg-white/10 text-ink placeholder:text-ink-muted/50 focus:outline-none"
            />
            <button type="submit" className="px-2 py-1 rounded-lg text-[11px] font-medium bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15 transition-colors">
              Apply
            </button>
          </form>
        </>
      )}

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete selected rows"
        className="px-2 py-1 rounded-lg text-[11px] font-medium text-rose-500 hover:bg-rose-500/10 transition-colors"
      >
        Delete
      </button>

      <button type="button" onClick={onClear} className="ml-auto text-[11px] text-ink-muted hover:text-ink transition-colors">
        Clear selection
      </button>
    </div>
  )
}

export function BuildGrid({ rows, typeById }: BuildGridProps) {
  const rawRows = useBuildRowsStore((s) => s.rows)
  const addSibling = useBuildRowsStore((s) => s.addSibling)
  const addChild = useBuildRowsStore((s) => s.addChild)
  const updateRow = useBuildRowsStore((s) => s.updateRow)
  const removeRow = useBuildRowsStore((s) => s.removeRow)
  const entityTypes = useViewEntityTypes()
  const setRowLayer = useBuildRowsStore((s) => s.setRowLayer)
  const duplicateRowSubtree = useBuildRowsStore((s) => s.duplicateRowSubtree)

  // The view's own layers (never hard-coded) — same source `resolveRowLayer`'s
  // typeId→layerId map derives from, so the Layer column's default always
  // matches Apply-time placement.
  const rawLayers = useLayers()
  const sortedLayers = useMemo(() => [...rawLayers].sort((a, b) => a.order - b.order), [rawLayers])
  const typeLayerMap = useMemo(() => buildTypeLayerMap(sortedLayers), [sortedLayers])

  const rawIdSet = useMemo(() => new Set(rawRows.map((r) => r.id)), [rawRows])
  const displayIds = useMemo(() => rows.map((r) => r.id), [rows])
  const selectableIds = useMemo(() => displayIds.filter((id) => rawIdSet.has(id)), [displayIds, rawIdSet])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index].id,
  })

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)

  const toggleRowSelection = (id: string, shiftKey: boolean) => {
    // Capture the anchor and advance the ref BEFORE calling setSelectedIds —
    // the updater below can run after this function returns, by which point
    // a same-tick `lastClickedRef.current = id` would have already clobbered
    // the anchor it needs to read.
    const anchor = lastClickedRef.current
    lastClickedRef.current = id
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (shiftKey && anchor) {
        for (const rid of computeRangeIds(displayIds, anchor, id)) {
          if (rawIdSet.has(rid)) next.add(rid)
        }
      } else if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Drop any selected id that no longer exists (row removed elsewhere).
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false
      const next = new Set<string>()
      prev.forEach((id) => {
        if (rawIdSet.has(id)) next.add(id)
        else changed = true
      })
      return changed ? next : prev
    })
  }, [rawIdSet])

  const handleDuplicate = (row: BuildRow) => {
    duplicateRowSubtree(row.id)
  }

  const applyFillDown = (patch: Partial<BuildRow>) => {
    selectedIds.forEach((id) => { if (rawIdSet.has(id)) updateRow(id, patch) })
  }

  const handleDeleteSelected = () => {
    selectedIds.forEach((id) => removeRow(id))
    setSelectedIds(new Set())
  }

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id))
  const handleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableIds))
  }

  const handlePasteDown = (startId: string, field: 'name' | 'description', lines: string[]) => {
    const ids = computeDownIds(displayIds, startId, lines.length).filter((id) => rawIdSet.has(id))
    ids.forEach((id, i) => updateRow(id, { [field]: lines[i] }))
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center px-8">
        <div className="max-w-xs space-y-2">
          <DynamicIcon name="LayoutGrid" className="w-6 h-6 mx-auto text-ink-muted/40" />
          <p className="text-sm text-ink-muted">Add rows from the Outline tab, or start typing here.</p>
          <button
            type="button"
            onClick={() => addSibling('')}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15 transition-colors"
          >
            Add first row
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {selectedIds.size >= 1 && (
        <FillDownBar
          count={selectedIds.size}
          entityTypes={entityTypes}
          typeById={typeById}
          rawRows={rawRows}
          selectedIds={selectedIds}
          onApply={applyFillDown}
          onDelete={handleDeleteSelected}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-glass-border text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
        <span className="w-5 flex-shrink-0 flex items-center justify-center">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={selectableIds.length === 0}
            onChange={handleSelectAll}
            aria-label="Select all rows"
            className="w-3.5 h-3.5 accent-accent-lineage normal-case"
          />
        </span>
        <span className="flex-[2] min-w-0">Name</span>
        <span className="w-32 flex-shrink-0">Type</span>
        <span className="w-32 flex-shrink-0">Parent</span>
        <span className="w-28 flex-shrink-0">Layer</span>
        <span className="flex-[2] min-w-0">Description</span>
        <span className="w-4 flex-shrink-0" />
        <span className="w-[92px] flex-shrink-0" />
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar relative">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            const isSynthetic = !rawIdSet.has(row.id)
            const type = row.typeId ? typeById.get(row.typeId) : undefined
            return (
              <div
                key={row.id}
                data-index={virtualRow.index}
                data-build-grid-row
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <BuildGridRow
                  row={row}
                  isSynthetic={isSynthetic}
                  type={type}
                  typeById={typeById}
                  entityTypes={entityTypes}
                  rawRows={rawRows}
                  layers={sortedLayers}
                  typeLayerMap={typeLayerMap}
                  selected={selectedIds.has(row.id)}
                  onToggleSelect={(shiftKey) => toggleRowSelection(row.id, shiftKey)}
                  onUpdate={(patch) => updateRow(row.id, patch)}
                  onSetLayer={(layerId) => setRowLayer(row.id, layerId)}
                  onPasteDown={(field, lines) => handlePasteDown(row.id, field, lines)}
                  onAddSibling={() => addSibling(row.id)}
                  onAddChild={() => addChild(row.id)}
                  onDuplicate={() => handleDuplicate(row)}
                  onRemove={() => removeRow(row.id)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
