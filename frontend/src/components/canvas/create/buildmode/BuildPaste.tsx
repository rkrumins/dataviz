/**
 * BuildPaste — the "Paste" tab body of the Build panel (Task 7). A textarea
 * of an indented list, live-parsed by the SAME `parseIndentedOutline`
 * `HierarchyBuilderPanel`'s rail Paste mode uses (never a forked parser) —
 * ontology-aware, so type inference/legality is identical everywhere it's
 * used. Each previewed row shows its inferred TYPE and its type-derived
 * target column, from the SAME `typeId → layerId` map the Grid's Layer
 * column uses (`buildTypeLayerMap` over the view's own `useLayers()`), so
 * Paste placement always agrees with Outline/Grid. Rows with issues (illegal
 * type/nesting) are shown clearly and excluded — along with any descendant
 * under them, since their real parent never lands — from the count and the
 * add (mirrors `useHierarchyOutline.stageRows`'s cascading skip).
 *
 * "Add N items" converts the parsed rows into `BuildRow[]` (depth threaded
 * into `parentId`, fresh ids) and appends them to the SAME `buildRowsStore`
 * Outline/Grid read/write. Staging and per-row layer assignment happen
 * exclusively in `BuildPanel`'s shared Apply flow (`stageBuildRows` +
 * `resolveRowLayer`) — nothing here re-implements that.
 */
import { useMemo, useState } from 'react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import { useLayers } from '@/store/referenceModelStore'
import type { EntityTypeSchema } from '@/types/schema'
import { parseIndentedOutline, type OutlineParseContext, type ParsedOutlineRow } from '../outlineParser'
import type { BuildOntologyCtx } from './validateBuildRows'
import { buildTypeLayerMap } from './resolveRowLayer'
import { makeRow, type BuildRow } from './buildRow'
import { useBuildRowsStore } from './buildRowsStore'

export interface BuildPasteProps {
  ctx: BuildOntologyCtx
  typeById: Map<string, EntityTypeSchema>
  /** Type of the real canvas node Build is scoped under, or `null` at the top
   *  level — feeds `parseIndentedOutline`'s `rootParentType` so the preview's
   *  legality matches the panel's own scope banner. */
  rootParentType: string | null
}

const PLACEHOLDER = 'Sales Domain\n  Customers Platform\n    Orders Dataset'

/** Per-row "does this row make it into the batch" flags — a row is excluded
 *  when it has its own issue, has no type, or its parent (at `depth - 1`) was
 *  itself excluded (a child can't attach to a parent that never lands). */
function includedFlags(parsed: ParsedOutlineRow[]): boolean[] {
  const parentExcludedAt: boolean[] = []
  return parsed.map((row) => {
    const parentExcluded = row.depth > 0 && !!parentExcludedAt[row.depth]
    const excluded = row.issues.length > 0 || !row.typeId || parentExcluded
    parentExcludedAt[row.depth + 1] = excluded
    return !excluded
  })
}

/** Pure: threads `ParsedOutlineRow[]` depth into `BuildRow.parentId` (fresh
 *  ids), dropping excluded rows (see `includedFlags`) — same depth-stack
 *  shape `useHierarchyOutline.stageRows` uses for its own tree, adapted to
 *  `BuildRow`'s parentId model instead of staging directly. */
export function toBuildRows(parsed: ParsedOutlineRow[]): BuildRow[] {
  const included = includedFlags(parsed)
  const parentIdAt: (string | null)[] = [null]
  const rows: BuildRow[] = []
  parsed.forEach((row, i) => {
    if (!included[i]) return
    const id = crypto.randomUUID()
    const parentId = row.depth === 0 ? null : (parentIdAt[row.depth] ?? null)
    rows.push(makeRow({ id, name: row.name, typeId: row.typeId, parentId }))
    parentIdAt[row.depth + 1] = id
  })
  return rows
}

/** The ontology-colored icon chip — matches BuildOutline's/BuildGrid's TypeChip. */
function TypeChip({ type }: { type?: EntityTypeSchema }) {
  return (
    <span
      className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${type?.visual?.color}20`, color: type?.visual?.color }}
    >
      <DynamicIcon name={type?.visual?.icon ?? 'Box'} className="w-2.5 h-2.5" />
    </span>
  )
}

export function BuildPaste({ ctx, typeById, rootParentType }: BuildPasteProps) {
  const [text, setText] = useState('')
  const rawRows = useBuildRowsStore((s) => s.rows)
  const setRows = useBuildRowsStore((s) => s.setRows)

  const parseCtx = useMemo<OutlineParseContext>(() => ({ ...ctx, rootParentType }), [ctx, rootParentType])
  const parsed = useMemo(() => (text.trim() ? parseIndentedOutline(text, parseCtx) : []), [text, parseCtx])
  const included = useMemo(() => includedFlags(parsed), [parsed])

  // The view's own layers (never hard-coded) — same source the Grid's Layer
  // column derives from, so a row's previewed target always matches Apply-time placement.
  const rawLayers = useLayers()
  const sortedLayers = useMemo(() => [...rawLayers].sort((a, b) => a.order - b.order), [rawLayers])
  const typeLayerMap = useMemo(() => buildTypeLayerMap(sortedLayers), [sortedLayers])
  const layerNameById = useMemo(() => new Map(sortedLayers.map((l) => [l.id, l.name])), [sortedLayers])

  const rowsToAdd = useMemo(() => toBuildRows(parsed), [parsed])

  const handleAdd = () => {
    if (rowsToAdd.length === 0) return
    setRows([...rawRows, ...rowsToAdd])
    setText('')
  }

  return (
    <div className="p-5 space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={PLACEHOLDER}
        className="input w-full resize-none font-mono text-xs leading-relaxed"
      />
      <p className="text-[11px] text-ink-muted">
        Indent with spaces or tabs to nest. Prefix a line with <span className="font-mono">Type:</span> to set it
        explicitly — otherwise the type (and its column) is inferred.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-ink-muted">
          {parsed.length === 0 ? 'Nothing pasted yet' : `${rowsToAdd.length} of ${parsed.length} ready to add`}
        </span>
        <button
          type="button"
          onClick={handleAdd}
          disabled={rowsToAdd.length === 0}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5',
            rowsToAdd.length > 0
              ? 'bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/15'
              : 'bg-black/5 dark:bg-white/10 text-ink-muted cursor-not-allowed',
          )}
        >
          <DynamicIcon name="Plus" className="w-3.5 h-3.5" />
          Add {rowsToAdd.length} item{rowsToAdd.length === 1 ? '' : 's'}
        </button>
      </div>

      {parsed.length > 0 ? (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-1.5 space-y-0.5">
          {parsed.map((row, i) => {
            const type = row.typeId ? typeById.get(row.typeId) : undefined
            const targetLayerId = row.typeId ? typeLayerMap.get(row.typeId.toLowerCase()) : undefined
            const targetLayerName = targetLayerId ? layerNameById.get(targetLayerId) : undefined
            const ownIssue = row.issues[0]
            const excluded = !included[i]
            const note = ownIssue ?? (excluded ? 'Fix the row above to include this one.' : undefined)
            return (
              <div
                key={i}
                title={note}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2 py-1.5',
                  excluded && (ownIssue ? 'bg-rose-500/10' : 'opacity-50'),
                )}
                style={{ paddingLeft: 8 + row.depth * 16 }}
              >
                <TypeChip type={type} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-xs truncate', ownIssue ? 'text-rose-600 dark:text-rose-400' : 'text-ink')}>
                    {row.name || '(unnamed)'}
                  </span>
                  {note && <span className="block text-[10px] text-rose-500 truncate">{note}</span>}
                </span>
                <span className="flex-shrink-0 text-[10px] text-ink-muted/70 truncate max-w-[110px]">
                  {type?.name ?? row.typeId ?? 'unknown type'}
                </span>
                {targetLayerName && (
                  <span className="flex-shrink-0 text-[10px] text-ink-muted/50 truncate max-w-[110px]">
                    → {targetLayerName}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-center py-8 space-y-1.5">
          <DynamicIcon name="ClipboardList" className="w-6 h-6 mx-auto text-ink-muted/40" />
          <p className="text-sm text-ink-muted">
            Paste an indented list — each line becomes an entity and nested lines become its children. Top-level
            entities go to their column; nested items stay under their parent.
          </p>
        </div>
      )}
    </div>
  )
}
