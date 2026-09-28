/**
 * What the relationship drawer opens on when a drawn line is clicked.
 *
 * A drawn line is not a relationship. The Context View draws `bundle-A->B`
 * lines (even for one edge), a trace draws `bundle:A>B:raw` wires, and the
 * Graph canvas draws `proj:` / `agg:` lines — each between the nearest VISIBLE
 * ancestors of the real endpoints, and each rebuilt on every expand, drill and
 * filter. So the click is resolved HERE, once, into a snapshot the drawer can
 * keep: one relationship (with the endpoints it really names), or a connection
 * listing the relationships the line stands for.
 */
import type { DrawerEdgeTarget, EdgeMemberRef, LineageEdge } from '@/store/canvas'
import { NON_DRAWABLE_EDGE_TYPES } from '@/services/ontologyPreflightService'

/** A relationship as a drawn line carries it: a projection member (which keeps
 *  its original endpoints in `_origSource`/`_origTarget`) or a store edge. */
interface LineMember {
  id?: string
  source?: string
  target?: string
  _origSource?: string
  _origTarget?: string
  originalType?: string
  data?: { edgeType?: string; relationship?: string }
}

/** Any drawn line: a projected bundle, a trace wire, a Graph canvas line or a store edge. */
export interface DrawnLine {
  id: string
  source: string
  target: string
  types?: string[]
  edgeCount?: number
  isBidirectional?: boolean
  isBundled?: boolean
  /** Trace wires only. */
  kind?: 'raw' | 'rollup' | 'residual'
  data?: {
    edgeType?: string
    relationship?: string
    edgeTypes?: string[]
    edgeCount?: number
    members?: LineMember[]
  }
}

const isRollupType = (t: string): boolean => NON_DRAWABLE_EDGE_TYPES.has(t.toUpperCase())

function memberRef(m: LineMember): EdgeMemberRef | null {
  const source = m._origSource ?? m.source
  const target = m._origTarget ?? m.target
  if (!m.id || !source || !target) return null
  const edgeType = m.data?.edgeType || m.data?.relationship || m.originalType || ''
  return { id: m.id, source, target, edgeType, rollup: isRollupType(edgeType) }
}

/** A relationship straight from a store edge (the Edge Explorer's cards). */
export function targetFromEdge(edge: LineageEdge, lineId?: string): DrawerEdgeTarget {
  return {
    kind: 'relationship',
    id: edge.id,
    source: edge.source,
    target: edge.target,
    edgeType: edge.data?.edgeType || edge.data?.relationship || '',
    ...(lineId ? { lineId } : {}),
  }
}

/** A relationship from one member of a connection. */
export function targetFromMember(m: EdgeMemberRef, lineId?: string): DrawerEdgeTarget {
  return {
    kind: 'relationship',
    id: m.id,
    source: m.source,
    target: m.target,
    edgeType: m.edgeType,
    ...(lineId ? { lineId } : {}),
  }
}

export function targetFromLine(
  line: DrawnLine,
  storeEdge: (id: string) => LineageEdge | undefined,
): DrawerEdgeTarget {
  const members = (line.data?.members ?? [])
    .map(memberRef)
    .filter((m): m is EdgeMemberRef => m !== null)

  // A line that stands for exactly one authored relationship IS that relationship.
  if (members.length === 1 && !members[0].rollup) return targetFromMember(members[0], line.id)

  const types = line.types ?? line.data?.edgeTypes
    ?? [line.data?.edgeType || line.data?.relationship].filter((t): t is string => !!t)
  const connection = {
    kind: 'connection' as const,
    id: line.id,
    source: line.source,
    target: line.target,
    types,
    weight: line.edgeCount ?? line.data?.edgeCount ?? Math.max(members.length, 1),
    ...(line.isBidirectional ? { bidirectional: true } : {}),
  }
  if (members.length > 0) return { ...connection, members }

  // No member list. A store edge drawn as itself is one relationship…
  const own = storeEdge(line.id)
  if (own) return targetFromEdge(own, line.id)
  // …and so is a trace wire drawn between the two cards its one hop joins —
  // the drawer finds the relationship itself by its (source, target, type).
  if (line.kind === 'raw' && line.isBundled === false && types.length === 1) {
    return { kind: 'relationship', id: line.id, source: line.source, target: line.target, edgeType: types[0], lineId: line.id }
  }
  // A summary wire or a roll-up line: what it summarises, without a list.
  return { ...connection, summaryOnly: true, members: [] }
}

/**
 * The drawn line a drawer target stands on NOW — the inverse of `targetFromLine`, for keeping that
 * line lit while the drawer is open. A line's id does not outlive the next expand, drill or filter,
 * so: the line by id; else the line that carries the relationship (or any of the connection's);
 * else the line joining the same two ends. Null when none is drawn.
 */
export function lineForTarget<L extends DrawnLine>(target: DrawerEdgeTarget, lines: readonly L[]): L | null {
  const lineId = target.kind === 'connection' ? target.id : target.lineId
  const byId = lineId ? lines.find((l) => l.id === lineId) : undefined
  if (byId) return byId
  const ids = new Set(target.kind === 'connection' ? target.members.map((m) => m.id) : [target.id])
  const carrying = lines.find((l) => l.data?.members?.some((m) => !!m.id && ids.has(m.id)))
  if (carrying) return carrying
  return lines.find((l) => (l.source === target.source && l.target === target.target)
    || (!!l.isBidirectional && l.source === target.target && l.target === target.source)) ?? null
}
