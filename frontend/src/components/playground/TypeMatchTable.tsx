/**
 * TypeMatchTable — each type a file uses, matched to a type of the chosen data model: found by its
 * id or name already, chosen by hand, or its rows left out. Thing types and connection types
 * alike, in the rows view-transfer's TypeMappingTable uses.
 *
 * A connection type matched to a relationship that joins only some types is checked against what
 * its rows join: a pair the relationship doesn't allow is named, since the import would refuse
 * those rows. On a data model of the reader's own, the types it lacks can be added to it here.
 */
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { caseFold } from '@/features/ontology/lib/caseFold'
import type { TypeMap, TypeRef, TypeSummary } from '@/features/import-export/fileRows'
import type { LayerTypesAdded, LayerTypesToAdd } from '@/services/playgroundService'
import { AddTypesToMyLayer } from './AddTypesToMyLayer'

/** The chosen data model's types; a relationship's `sourceTypes`/`targetTypes`, when it names
 *  any, are the only types it joins. */
export interface ModelTypes {
  entity: TypeRef[]
  relationship: (TypeRef & { sourceTypes: string[]; targetTypes: string[] })[]
}

export type TypeKind = 'entity' | 'relationship'

const CHOOSE = '__choose__'
const LEAVE_OUT = '__leave_out__'

const n = (count: number) => count.toLocaleString('en-US')
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** What the file uses that no type of the model is chosen for: the types to add to it. */
export function typesToAdd(summary: TypeSummary, map: TypeMap): LayerTypesToAdd {
  return {
    entityTypes: summary.thingTypes.filter(([t]) => !has(map.entity, t)).map(([name]) => ({ name })),
    relationshipTypes: summary.connectionTypes.filter(([t]) => !has(map.relationship, t)).map(([name]) => ({
      name,
      ends: (summary.connectionEnds[name] ?? [])
        .filter(([from, to]) => map.entity[from] !== null && map.entity[to] !== null)
        .map(([from, to]) => [map.entity[from] ?? from, map.entity[to] ?? to] as [string, string]),
    })),
  }
}

/** Connections of the type the chosen relationship doesn't join, as "From → To" pairs. */
function endsRefused(name: string, summary: TypeSummary, available: ModelTypes, map: TypeMap): string[] {
  const rel = available.relationship.find(r => r.id === map.relationship[name])
  if (!rel || (!rel.sourceTypes.length && !rel.targetTypes.length)) return []
  const allows = (list: string[], id: string) => !list.length || list.some(t => caseFold(t) === caseFold(id))
  const label = (id: string) => available.entity.find(e => e.id === id)?.name ?? id
  return (summary.connectionEnds[name] ?? []).flatMap(([from, to]) => {
    const f = map.entity[from]
    const t = map.entity[to]
    if (!f || !t || (allows(rel.sourceTypes, f) && allows(rel.targetTypes, t))) return []
    return [`${label(f)} → ${label(t)}`]
  })
}

export function TypeMatchTable({ summary, available, map, onMap, addTypes }: {
  summary: TypeSummary
  available: ModelTypes
  /** Each file type's choice: a type id, null to leave its rows out, absent while not chosen. */
  map: TypeMap
  onMap: (kind: TypeKind, name: string, target: string | null | undefined) => void
  /** The model is the reader's own: its missing types can be added to it. */
  addTypes?: { ontologyId: string; onAdded: (result: LayerTypesAdded) => void }
}) {
  const rows: { kind: TypeKind; name: string; count: number }[] = [
    ...summary.thingTypes.map(([name, count]) => ({ kind: 'entity' as const, name, count })),
    ...summary.connectionTypes.map(([name, count]) => ({ kind: 'relationship' as const, name, count })),
  ]
  if (rows.length === 0) return null

  return (
    <div className="space-y-3">
      <div role="table" aria-label="Match types" className="rounded-xl border border-glass-border divide-y divide-glass-border">
        {rows.map(({ kind, name, count }) => {
          const choices = kind === 'entity' ? map.entity : map.relationship
          const value = !has(choices, name) ? CHOOSE : choices[name] === null ? LEAVE_OUT : choices[name]!
          const options = kind === 'entity' ? available.entity : available.relationship
          const refused = kind === 'relationship' ? endsRefused(name, summary, available, map) : []
          return (
            <div key={`${kind}:${name}`} role="row" className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1" role="cell">
                  <p className="text-xs font-semibold text-ink font-mono truncate">{name}</p>
                  <p className="text-[10px] text-ink-muted truncate">
                    {kind === 'entity' ? `${n(count)} ${count === 1 ? 'thing' : 'things'}` : `${n(count)} ${count === 1 ? 'connection' : 'connections'}`}
                  </p>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
                <select
                  value={value}
                  aria-label={`Match ${name}`}
                  onChange={(e) => {
                    const v = e.target.value
                    onMap(kind, name, v === CHOOSE ? undefined : v === LEAVE_OUT ? null : v)
                  }}
                  className={cn('w-52 max-w-[50%] text-xs rounded-lg border px-2 py-1.5 bg-canvas-elevated text-ink',
                    value === LEAVE_OUT ? 'border-rose-300 dark:border-rose-800'
                      : value === CHOOSE ? 'border-amber-400 dark:border-amber-700' : 'border-indigo-300 dark:border-indigo-800')}>
                  <option value={CHOOSE} disabled>Choose a type…</option>
                  <optgroup label={kind === 'entity' ? 'Thing types here' : 'Connection types here'}>
                    {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </optgroup>
                  <option value={LEAVE_OUT}>Leave these rows out</option>
                </select>
              </div>
              {refused.length > 0 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-px w-3 h-3 shrink-0" aria-hidden />
                  <span>
                    {options.find(o => o.id === value)?.name ?? value} doesn’t join {refused.slice(0, 2).join(' or ')}
                    {refused.length > 2 ? ` (and ${refused.length - 2} more)` : ''} in this data model: those connections
                    would be refused. Choose another type, or leave them out.
                  </span>
                </p>
              )}
            </div>
          )
        })}
      </div>
      {addTypes && <AddTypesToMyLayer ontologyId={addTypes.ontologyId} missing={typesToAdd(summary, map)} onAdded={addTypes.onAdded} />}
    </div>
  )
}
