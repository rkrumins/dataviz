/**
 * The connection model — one truthful shape for the Connections panel.
 *
 * Pure: no React, no schema, no store imports. Both a projected bundle from
 * `useEdgeProjection` and a trace wire map onto `ConnectionBundle`, so the
 * panel drives browse and trace off the same computation.
 */

/** One line on the canvas, as the panel needs to read it. Both a projected
 *  bundle from useEdgeProjection and a trace wire map onto this shape. */
export interface ConnectionBundle {
  id: string
  /** Underlying relationships this line stands for. */
  edgeCount: number
  /** UPPERCASE-or-not type names; the model uppercases them. */
  types: readonly string[]
  isReverseFlow?: boolean
  isBidirectional?: boolean
}

export interface ConnectionTypeRow {
  /** UPPERCASE key — the same key the visibility store and the ontology use. */
  type: string
  /** Sum of edgeCount over bundles carrying this type. A bundle carrying
   *  two types is counted in BOTH rows and once in the header total. */
  relationships: number
  /** How many bundles carry this type. */
  bundles: number
  /** Bundle ids carrying this type — the highlight channel's payload. */
  bundleIds: string[]
  /** Direction split, in edgeCount. Each bundle lands in exactly one bucket. */
  forward: number
  backward: number
  bidirectional: number
}

export interface ConnectionModel {
  /** Sorted by relationships desc, then type asc. */
  rows: ConnectionTypeRow[]
  /** Sum of edgeCount over ALL bundles, each counted EXACTLY once. */
  relationships: number
  bundles: number
  typeCount: number
  /** Sum of edgeCount of bundles carrying no type at all, so the header
   *  total is never larger than the rows can account for. */
  untyped: number
}

export const EMPTY_CONNECTION_MODEL: ConnectionModel = {
  rows: [],
  relationships: 0,
  bundles: 0,
  typeCount: 0,
  untyped: 0,
}

function count(bundle: ConnectionBundle): number {
  return typeof bundle.edgeCount === 'number' && bundle.edgeCount > 0 ? bundle.edgeCount : 1
}

export function buildConnectionModel(bundles: readonly ConnectionBundle[]): ConnectionModel {
  if (bundles.length === 0) return EMPTY_CONNECTION_MODEL

  const byType = new Map<string, ConnectionTypeRow>()
  let relationships = 0
  let untyped = 0

  for (const bundle of bundles) {
    const n = count(bundle)
    relationships += n

    const types = [...new Set(bundle.types.map((t) => t.toUpperCase()))]
    if (types.length === 0) {
      untyped += n
      continue
    }

    const bucket: 'bidirectional' | 'backward' | 'forward' = bundle.isBidirectional
      ? 'bidirectional'
      : bundle.isReverseFlow
        ? 'backward'
        : 'forward'

    for (const type of types) {
      let row = byType.get(type)
      if (!row) {
        row = { type, relationships: 0, bundles: 0, bundleIds: [], forward: 0, backward: 0, bidirectional: 0 }
        byType.set(type, row)
      }
      row.relationships += n
      row.bundles += 1
      row.bundleIds.push(bundle.id)
      row[bucket] += n
    }
  }

  const rows = [...byType.values()].sort(
    (a, b) => b.relationships - a.relationships || a.type.localeCompare(b.type),
  )

  return { rows, relationships, bundles: bundles.length, typeCount: rows.length, untyped }
}
