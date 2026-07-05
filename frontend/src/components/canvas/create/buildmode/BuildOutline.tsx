/**
 * BuildOutline — the keyboard-first "Outline" tab body of the Build panel
 * (Task 6). Renders `buildRowsStore.rows` as an indented tree and edits them
 * directly through the store — no local draft state, every keystroke is
 * already the committed row.
 *
 * `rows` here is BuildPanel's already-computed `validateBuildRows(rows, ctx)`
 * view (recomputed on every render from the live store), not a second
 * validation pass — the outline's type chips/status match the panel's
 * footer summary exactly. Validation can synthesize NEW rows (auto-inserted
 * missing ancestor levels) that don't exist in the store yet; those render
 * read-only (no input, no keyboard handling, dimmed) since there's no row id
 * the store recognizes to mutate.
 *
 * Keyboard model on a (non-synthetic) row's name input, matching the rail's
 * `HierarchyBuilderPanel`/`useHierarchyOutline` vocabulary but written fresh
 * against `buildRowsStore` (that hook's API is out of scope to touch):
 *   Enter      → addSibling(id), then focus the new row — UNLESS the row is
 *                EMPTY and not already at the top level, in which case Enter
 *                outdents it one level instead (doc-editor idiom); repeated
 *                Enter on an empty row climbs to the top, then a further
 *                Enter there starts a fresh top-level row (Task 3).
 *   Tab        → addChild(id), then focus the new row
 *   Shift+Tab  → reparent to the grandparent (outdent), via updateRow
 *   Escape     → blur (stop editing this row)
 *
 * Each row's type label is also a picker (Task 4) — options are the
 * ontology-legal children of the row's PARENT type (`builderAllowedChildTypeIds`,
 * the same gate `useHierarchyOutline.ts` uses), or the legal top-level types
 * for a depth-0 row; picking one writes `updateRow(id, { typeId })`.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import {
  useViewEntityTypes,
  useViewRootEntityTypes,
  useViewEntityTypeHierarchyMap,
  useViewRelationshipTypes,
  useViewContainmentEdgeTypes,
} from '@/hooks/useViewSchema'
import { builderAllowedChildTypeIds } from '@/services/ontologyPreflightService'
import type { EntityTypeSchema } from '@/types/schema'
import type { BuildRow } from './buildRow'
import { useBuildRowsStore } from './buildRowsStore'
import { grandparentIdOf } from './buildOutlineOutdent'
import { TypePickerPopover } from './TypePickerPopover'

export interface BuildOutlineProps {
  /** Validated rows (BuildPanel's `validateBuildRows(rows, ctx)`) — live type inference + status. */
  rows: BuildRow[]
  typeById: Map<string, EntityTypeSchema>
}

const STATUS_BADGE: Record<BuildRow['status'], { icon: string; cls: string } | null> = {
  valid: null,
  fixed: { icon: 'Wand2', cls: 'text-amber-500' },
  error: { icon: 'AlertTriangle', cls: 'text-rose-500' },
}

/** The ontology-colored icon chip — matches BuildPanel's/HierarchyBuilderPanel's TypeChip. */
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

export function BuildOutline({ rows, typeById }: BuildOutlineProps) {
  const rawRows = useBuildRowsStore((s) => s.rows)
  const addSibling = useBuildRowsStore((s) => s.addSibling)
  const addChild = useBuildRowsStore((s) => s.addChild)
  const updateRow = useBuildRowsStore((s) => s.updateRow)
  const removeRow = useBuildRowsStore((s) => s.removeRow)

  const entityTypes = useViewEntityTypes()
  const rootEntityTypes = useViewRootEntityTypes()
  const hierarchyMap = useViewEntityTypeHierarchyMap()
  const relationshipTypes = useViewRelationshipTypes()
  const containmentEdgeTypes = useViewContainmentEdgeTypes()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [typePickerRowId, setTypePickerRowId] = useState<string | null>(null)
  const inputRefs = useRef(new Map<string, HTMLInputElement>())
  // Snapshot of row ids taken right before a store mutation that adds a row
  // (addSibling/addChild generate the new id internally via crypto.randomUUID,
  // so it isn't known synchronously) — the effect below diffs against it to
  // find + focus the one row that's new.
  const pendingFocusIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    const prevIds = pendingFocusIds.current
    if (!prevIds) return
    pendingFocusIds.current = null
    const created = rawRows.find((r) => !prevIds.has(r.id))
    if (created) {
      inputRefs.current.get(created.id)?.focus()
      setActiveId(created.id)
    }
  }, [rawRows])

  const armFocusNext = () => { pendingFocusIds.current = new Set(rawRows.map((r) => r.id)) }
  const rawIds = new Set(rawRows.map((r) => r.id))

  /** `row`'s parent's typeId — looked up in the validated `rows` (so an
   *  auto-inserted synthetic ancestor's type counts too), or `null` at the
   *  top level. */
  const parentTypeOf = (row: BuildRow): string | null => {
    if (row.parentId == null) return null
    return rows.find((r) => r.id === row.parentId)?.typeId ?? null
  }

  /** Task 4: the ontology-legal types for `row`'s slot — the legal children
   *  of its parent's type (or the legal top-level types at depth 0). */
  const legalTypesForRow = (row: BuildRow): EntityTypeSchema[] => {
    const ids = builderAllowedChildTypeIds(
      parentTypeOf(row), entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes,
    )
    return entityTypes.filter((t) => ids.has(t.id))
  }

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, row: BuildRow) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (row.name.trim() === '' && row.depth > 0) {
        // Empty row, not yet at the top level: outdent one level (doc-editor
        // idiom) instead of adding a same-depth sibling. Repeated Enter climbs
        // to depth 0; a further Enter there falls through below and starts a
        // new top-level row.
        const grandparentId = grandparentIdOf(rawRows, row.id)
        if (grandparentId !== undefined) updateRow(row.id, { parentId: grandparentId })
      } else {
        armFocusNext()
        addSibling(row.id)
      }
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      armFocusNext()
      addChild(row.id)
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      const grandparentId = grandparentIdOf(rawRows, row.id)
      if (grandparentId !== undefined) updateRow(row.id, { parentId: grandparentId })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center px-8">
        <div className="max-w-xs space-y-2">
          <DynamicIcon name="List" className="w-6 h-6 mx-auto text-ink-muted/40" />
          <p className="text-sm text-ink-muted">
            Add entities one at a time, keyboard-first — type a name, press Enter for the next, Tab to nest a child
            inside it. Each one is placed in the column that matches its type.
          </p>
          <button
            type="button"
            onClick={() => { armFocusNext(); addSibling('') }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15 transition-colors"
          >
            Add first row
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="py-2">
      {rows.map((row) => {
        const isSynthetic = !rawIds.has(row.id)
        const type = row.typeId ? typeById.get(row.typeId) : undefined
        const badge = STATUS_BADGE[row.status]
        const title = row.status === 'error'
          ? row.issues.map((i) => i.message).join(' ')
          : row.status === 'fixed'
            ? row.fixes.map((f) => f.note).join(' ')
            : undefined

        return (
          <div
            key={row.id}
            title={title}
            className={cn(
              'group/row flex items-center gap-2 mx-2 px-2 py-1.5 rounded-lg transition-colors',
              isSynthetic ? 'opacity-60' : 'hover:bg-black/5 dark:hover:bg-white/5',
              activeId === row.id && !isSynthetic && 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30',
            )}
            style={{ paddingLeft: 8 + row.depth * 20 }}
          >
            <TypeChip type={type} />

            {isSynthetic ? (
              <span className="flex-1 min-w-0 text-sm italic text-ink-muted truncate">
                {row.name} <span className="text-[10px] not-italic">(auto)</span>
              </span>
            ) : (
              <input
                ref={(el) => {
                  if (el) inputRefs.current.set(row.id, el)
                  else inputRefs.current.delete(row.id)
                }}
                value={row.name}
                onChange={(e) => updateRow(row.id, { name: e.target.value })}
                onFocus={() => setActiveId(row.id)}
                onBlur={() => setActiveId((cur) => (cur === row.id ? null : cur))}
                onKeyDown={(e) => onNameKeyDown(e, row)}
                placeholder="Name…"
                className="flex-1 min-w-0 bg-transparent text-sm text-ink placeholder:text-ink-muted/50 focus:outline-none border-b border-transparent focus:border-accent-lineage/40"
              />
            )}

            {isSynthetic ? (
              <span className="flex-shrink-0 text-[10px] text-ink-muted/70 truncate max-w-[140px]">
                {type?.name ?? row.typeId ?? 'unknown type'}
              </span>
            ) : (
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setTypePickerRowId((cur) => (cur === row.id ? null : row.id))}
                  aria-label={`Type for ${row.name || 'row'}`}
                  className="text-[10px] text-ink-muted/70 hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded px-1 -mx-1 truncate max-w-[140px] transition-colors"
                >
                  {type?.name ?? row.typeId ?? 'unknown type'}
                </button>
                {typePickerRowId === row.id && (
                  <TypePickerPopover
                    entityTypes={legalTypesForRow(row)}
                    selectedId={row.typeId}
                    onPick={(id) => { updateRow(row.id, { typeId: id }); setTypePickerRowId(null) }}
                    onClose={() => setTypePickerRowId(null)}
                  />
                )}
              </div>
            )}

            {badge && <DynamicIcon name={badge.icon} className={cn('w-3.5 h-3.5 flex-shrink-0', badge.cls)} />}

            {!isSynthetic && (
              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover/row:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => { armFocusNext(); addChild(row.id) }}
                  title="Add a child row"
                  aria-label="Add a child row"
                  className="p-1 rounded text-ink-muted hover:text-accent-lineage hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                >
                  <DynamicIcon name="CornerDownRight" className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  title="Remove"
                  aria-label="Remove"
                  className="p-1 rounded text-ink-muted hover:text-rose-500 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                >
                  <DynamicIcon name="X" className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
