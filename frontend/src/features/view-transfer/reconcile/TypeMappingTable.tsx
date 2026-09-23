/**
 * Types the view uses that this data source's semantic layer doesn't have: map each to a type
 * that exists here (the likeliest first), leave it (nothing will match it), or take it out of the
 * view. Entity and relationship types alike.
 *
 * Types already mapped or taken out are listed too: once the choice is checked, the design no
 * longer uses them, so the report doesn't name them, and this is where they can be changed back.
 */
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReconcileTypeRow, Resolutions } from '@/services/viewTransferApiService'
import { typeDecisionOf, type TypeKind } from './resolutions'

const KEEP = '__keep__'
const DROP = '__drop__'

/** The missing types, then those decided already that the report no longer names. */
function rowsOf(kind: TypeKind, types: ReconcileTypeRow[], draft: Resolutions): Array<{ kind: TypeKind; row: ReconcileTypeRow }> {
  const missing = types.filter(t => t.status === 'missing')
  const listed = new Set(missing.map(t => t.id))
  const map = kind === 'entity' ? draft.typeMap : draft.relTypeMap
  const drops = kind === 'entity' ? draft.dropTypes : draft.dropRelTypes
  const decided = [...new Set([...Object.keys(map ?? {}), ...(drops ?? [])])].filter(id => !listed.has(id)).sort()
  return [...missing, ...decided.map(id => ({ id, status: 'missing' as const, suggestions: [], layers: [] }))]
    .map(row => ({ kind, row }))
}

export function TypeMappingTable({ entityTypes, relationshipTypes, available, draft, onDecide }: {
  entityTypes: ReconcileTypeRow[]
  relationshipTypes: ReconcileTypeRow[]
  /** The types this data source has, id → label. */
  available: { entity: Array<{ id: string; name: string }>; relationship: Array<{ id: string; name: string }> }
  /** The choices being made. */
  draft: Resolutions
  /** `target`: a type here to map to, `null` to take the type out, `undefined` to leave it. */
  onDecide: (kind: TypeKind, id: string, target: string | null | undefined) => void
}) {
  const rows = [...rowsOf('entity', entityTypes, draft), ...rowsOf('relationship', relationshipTypes, draft)]
  if (rows.length === 0) return null

  return (
    <div className="rounded-xl border border-glass-border divide-y divide-glass-border">
      {rows.map(({ kind, row }) => {
        const decision = typeDecisionOf(draft, kind, row.id)
        const value = decision === null ? DROP : decision === undefined ? KEEP : decision
        const options = kind === 'entity' ? available.entity : available.relationship
        const suggested = new Set(row.suggestions)
        return (
          <div key={`${kind}:${row.id}`} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-ink font-mono truncate">{row.id}</p>
              <p className="text-[10px] text-ink-muted truncate">
                {kind === 'entity' ? 'Entity type' : 'Relationship type'}
                {row.layers.length > 0 ? ` · used by ${row.layers.join(', ')}` : ''}
              </p>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <select
              value={value}
              aria-label={`Map ${row.id}`}
              onChange={(e) => {
                const v = e.target.value
                onDecide(kind, row.id, v === KEEP ? undefined : v === DROP ? null : v)
              }}
              className={cn('w-56 text-xs rounded-lg border px-2 py-1.5 bg-canvas-elevated text-ink',
                value === DROP ? 'border-rose-300 dark:border-rose-800' : value === KEEP ? 'border-glass-border' : 'border-indigo-300 dark:border-indigo-800')}>
              <option value={KEEP}>Leave it (matches nothing here)</option>
              {row.suggestions.length > 0 && (
                <optgroup label="Likely the same">
                  {row.suggestions.map(id => <option key={id} value={id}>{options.find(o => o.id === id)?.name ?? id}</option>)}
                </optgroup>
              )}
              <optgroup label={kind === 'entity' ? 'Entity types here' : 'Relationship types here'}>
                {options.filter(o => !suggested.has(o.id)).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </optgroup>
              <option value={DROP}>Take it out of the view</option>
            </select>
          </div>
        )
      })}
    </div>
  )
}
