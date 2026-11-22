/**
 * fillRequired — the bulk dialog opened to give a required field a value where it has none:
 * "Fill if empty" on the field, the value left for the person to give.
 *
 * - From a drawer: every entity of the type missing it, as a search. Missing is as a publish's
 *   required rule reads it (no key, null, '' or []), which the search's `isEmpty` matches. A
 *   search reads Published, so it reaches the entities Published holds without one. Every
 *   relationship of a type missing it is a Connections search the same way.
 * - From a refused publish: the entities it refused, by id (`byField[].ids`). Those are new in the
 *   draft or emptied there, which a search of Published never reaches. A job names at most
 *   `MAX_IDS`, so a refusal of more is filled the first `MAX_IDS` at a time.
 */
import type { Predicate } from '@/types/search'
import type { OpRequest } from '@/store/propertyJobsStore'
import { predicateOf, type ScopeMode, type TargetPreset } from './opModel'

/** Every `entityType` entity whose `field` is empty, searched in `scopeMode`. */
export function fillRequiredRequest({ entityType, entityTypeName, field, fieldName, scopeMode }: {
  entityType: string
  entityTypeName?: string
  field: string
  fieldName?: string
  scopeMode: ScopeMode
}): OpRequest {
  const predicate = {
    kind: 'group', op: 'and', children: [
      { kind: 'entityType', op: 'in', values: [entityType] },
      { kind: 'property', key: field, op: 'isEmpty' },
    ],
  } as Predicate
  return {
    op: { kind: 'fillEmpty', key: field },
    target: { kind: 'search', predicate, scopeMode, label: `every ${entityTypeName || entityType} missing ${fieldName || field}` },
    scopeMode,
  }
}

/** Every `edgeType` relationship whose `field` is empty, as a Connections search in `scopeMode`.
 *  A relationship keeps its properties as JSON text, which a search reads for a key or a value:
 *  empty is no key, or ''. */
export function fillRequiredConnectionsRequest({ edgeType, edgeTypeName, field, fieldName, scopeMode }: {
  edgeType: string
  edgeTypeName?: string
  field: string
  fieldName?: string
  scopeMode: ScopeMode
}): OpRequest {
  const predicate = {
    kind: 'edges', edgeTypes: [edgeType],
    edgePredicate: {
      kind: 'edgeGroup', op: 'or', children: [
        { kind: 'edgeHasProperty', key: field, negate: true },
        { kind: 'edgeProperty', key: field, op: 'eq', value: '' },
      ],
    },
  } as Predicate
  return {
    op: { kind: 'fillEmpty', key: field },
    target: {
      kind: 'connections', predicate, scopeMode,
      label: `every ${edgeTypeName || edgeType} relationship missing ${fieldName || field}`,
    },
    scopeMode,
  }
}

/** The entities a publish refused for an empty required `field`, by id: `ids` is all of them when
 *  `complete`, else the first `MAX_IDS`. `edges`: they are relationships, named by their own ids. */
export function fillRefusedRequest({ entityType, field, fieldName, ids, complete, edges = false }: {
  entityType: string
  field: string
  fieldName?: string
  ids: readonly string[]
  complete: boolean
  edges?: boolean
}): OpRequest {
  const missing = `missing ${fieldName || field}`
  return {
    op: { kind: 'fillEmpty', key: field },
    target: edges ? { kind: 'relationships', ids } : {
      kind: 'selection', ids, entityTypes: [entityType],
      label: complete ? `every ${entityType} the publish refused for ${missing}`
        : `the first ${ids.length.toLocaleString()} the publish refused for ${missing} on ${entityType}`,
    },
  }
}

/** The entity types a target keeps to, when it says: those of the ids it names, or a search's
 *  `entityType in` condition, alone or one of an AND's — null when it doesn't. */
export function entityTypesOf(preset: TargetPreset): readonly string[] | null {
  return preset.kind === 'selection' ? preset.entityTypes ?? null : typesIn(predicateOf(preset))
}

function typesIn(predicate: Predicate | null): string[] | null {
  const p = predicate as { kind?: string; op?: string; values?: string[]; children?: Predicate[] } | null
  if (p?.kind === 'entityType' && (p.op ?? 'in') === 'in') return p.values ?? null
  if (p?.kind === 'group' && (p.op ?? 'and') === 'and') {
    for (const child of p.children ?? []) {
      const types = typesIn(child)
      if (types) return types
    }
  }
  return null
}
