/**
 * The canvas is ALWAYS "what the server returned ⊕ the user's pending (unsaved) edits".
 *
 * Every write of server data into the canvas store goes through here — a full load (`setGraph`) and
 * every page merged in (`mergeGraph`) — so a reload can never wipe unsaved work. It used to: a
 * re-hydration (after a save changed the draft's diff, on a retry, on an ontology refresh) replaced
 * the canvas with the server's copy, so unsaved nodes vanished while their changes stayed staged —
 * "everything disappeared, and came back only when I saved". The canvas had grown three separate
 * guards against this, each covering one representation of unsaved work; this is the one rule.
 *
 * The pending representation is the canvas's own optimistic copy (what the user sees), identified by
 * the staged changes: an optimistic node or edge (`isPending`), or one a staged change targets (a
 * rename carries no marker). Relationships a staged change removed stay removed — including every
 * containment link into a node a staged MOVE re-parented, whether or not the canvas had loaded it.
 */
import type { LineageEdge, LineageNode } from './canvas'
import type { StagedChange } from './stagedChangesStore'

/** `after` of a staged `move_entity`: the child, its new parent (none = top level), the pending
 *  link's id, and the containment relationship types (uppercase) that count as "a parent link". */
export interface MoveAfter {
  childId: string
  parentId: string | null
  edgeId: string | null
  edgeType: string | null
  containmentTypes: string[]
}

const edgeTypeOf = (e: LineageEdge): string =>
  String((e.data as Record<string, unknown> | undefined)?.edgeType ?? '').toUpperCase()

interface PendingIndex {
  /** Node ids a staged change targets (id or urn). */
  touchedNodes: Set<string>
  /** Edge ids a staged change targets (edit / delete / create). */
  touchedEdges: Set<string>
  /** Edge ids a staged change deleted. */
  deletedEdges: Set<string>
  /** childId → the move that re-parented it (the latest wins). */
  moves: Map<string, MoveAfter>
}

function indexChanges(changes: readonly StagedChange[]): PendingIndex {
  const idx: PendingIndex = {
    touchedNodes: new Set(), touchedEdges: new Set(), deletedEdges: new Set(), moves: new Map(),
  }
  for (const c of changes) {
    switch (c.type) {
      case 'create_entity':
      case 'rename_entity':
      case 'update_entity':
      case 'delete_entity':
        idx.touchedNodes.add(c.targetId)
        if (c.targetUrn) idx.touchedNodes.add(c.targetUrn)
        break
      case 'create_edge':
      case 'edit_edge':
      case 'reverse_edge':
        idx.touchedEdges.add(c.targetId)
        break
      case 'delete_edge':
        idx.touchedEdges.add(c.targetId)
        idx.deletedEdges.add(c.targetId)
        break
      case 'move_entity': {
        const m = c.after as MoveAfter
        idx.moves.set(m.childId, m)
        if (m.edgeId) idx.touchedEdges.add(m.edgeId)
        break
      }
      default:
        break
    }
  }
  return idx
}

/** Would the pending state remove this (server) edge? A staged delete, or a parent link into a
 *  node a staged move re-parented (other than the move's own new link). */
function removedByPending(e: LineageEdge, idx: PendingIndex): boolean {
  if (idx.deletedEdges.has(e.id)) return true
  const m = idx.moves.get(e.target)
  return !!m && e.id !== m.edgeId && m.containmentTypes.includes(edgeTypeOf(e))
}

/** Pending edits carried over a FULL replace: `next` is the server's view, `prev` the canvas the
 *  user is looking at. Returns `next` untouched when nothing is staged. */
export function overlayOnReplace(
  next: { nodes: LineageNode[]; edges: LineageEdge[] },
  prev: { nodes: LineageNode[]; edges: LineageEdge[] },
  changes: readonly StagedChange[],
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  if (changes.length === 0) return next
  const idx = indexChanges(changes)

  const keepNode = (n: LineageNode) => !!n.data?.isPending || idx.touchedNodes.has(n.id)
    || idx.touchedNodes.has(String(n.data?.urn ?? ''))
  const prevNodes = new Map(prev.nodes.filter(keepNode).map((n) => [n.id, n]))
  const nodes = next.nodes.map((n) => prevNodes.get(n.id) ?? n)
  const seen = new Set(nodes.map((n) => n.id))
  for (const n of prevNodes.values()) if (!seen.has(n.id)) nodes.push(n)

  const keepEdge = (e: LineageEdge) => !!e.data?.isPending || idx.touchedEdges.has(e.id)
  const prevEdges = new Map(prev.edges.filter(keepEdge).map((e) => [e.id, e]))
  const edges = next.edges
    .filter((e) => prevEdges.has(e.id) || !removedByPending(e, idx))
    .map((e) => prevEdges.get(e.id) ?? e)
  const seenE = new Set(edges.map((e) => e.id))
  for (const e of prevEdges.values()) {
    if (!seenE.has(e.id) && !idx.deletedEdges.has(e.id)) edges.push(e)
  }
  return { nodes, edges }
}

/** Server edges arriving in a page merged INTO the canvas: drop the ones pending edits removed (a
 *  page of the old parent's children would otherwise bring a moved node's old link straight back). */
export function filterIncomingEdges(
  edges: LineageEdge[], changes: readonly StagedChange[],
): LineageEdge[] {
  if (changes.length === 0 || edges.length === 0) return edges
  const idx = indexChanges(changes)
  if (idx.deletedEdges.size === 0 && idx.moves.size === 0) return edges
  return edges.filter((e) => !removedByPending(e, idx))
}
