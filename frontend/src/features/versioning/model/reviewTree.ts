/**
 * reviewTree — Review & Save's staged changes top-down: each under its container, as the canvas
 * and the changes themselves place it — a new entity where it was created, a moved one where it
 * goes, an entity on the canvas under its parent (or the containers its feed named), a relationship
 * under its source. A changed entity the canvas has not loaded sits under "Elsewhere in the graph";
 * the view's layout under its own heading. Each container counts the changes under it, at any depth.
 *
 * Built once per list of changes (O(changes × depth)), in the browser: nothing is read to lay it out.
 * Pure: where the canvas places an entity comes from the caller (`Placement`).
 */
import type { ChangeStatus } from './changeModel'
import { edgeOf, type ReviewGroup } from './reviewModel'

/** The top of the tree. */
export const TOP = ''
/** Changed entities the canvas has not loaded: their container is not known here. */
export const ELSEWHERE = '~elsewhere'
/** The view's own layout: no container in the graph. */
export const LAYOUT = '~layout'

/** Where the canvas places an entity. */
export interface Placement {
  /** Its container's id; null at the top; undefined when the canvas does not know it. */
  parentOf: (id: string) => string | null | undefined
  /** The id the tree knows an entity by (its urn), for an id the canvas uses instead. */
  keyOf: (id: string) => string
  nameOf: (id: string) => string
  typeOf: (id: string) => string | undefined
}

export interface ReviewTree {
  /** Each container's children, most-changed first (entities, then relationships). */
  children: Map<string, string[]>
  /** Each item's container (`TOP` at the top). */
  parentOf: Map<string, string>
  /** Changes under each container, at any depth: [added, modified, removed]. */
  rollup: Map<string, [number, number, number]>
  /** A changed item's group (an index into the groups it was built from). */
  groupOf: Map<string, number>
  /** Where each sits among its container's children. */
  rank: Map<string, number>
  /** An item's name and type. */
  nameOf: (id: string) => string
  typeOf: (id: string) => string | undefined
}

const SLOT: Record<ChangeStatus, 0 | 1 | 2> = { added: 0, modified: 1, removed: 2 }
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/** The id a group is known by in the tree: an entity by its urn (what its children point at). */
export const treeIdOf = (g: ReviewGroup) => (g.kind === 'node' ? g.key : `${g.kind}:${g.key}`)

const cache = new WeakMap<readonly ReviewGroup[], ReviewTree>()

export function buildReviewTree(groups: readonly ReviewGroup[], place: Placement): ReviewTree {
  const hit = cache.get(groups)
  if (hit) return hit
  const groupOf = new Map<string, number>()
  // Where a change itself puts its entity (a create, a move): it wins over where the canvas has it.
  const staged = new Map<string, string>()
  groups.forEach((g, i) => {
    const id = treeIdOf(g)
    groupOf.set(id, i)
    if (g.kind === 'layout') { staged.set(id, LAYOUT); return }
    if (g.kind === 'edge') {
      const src = edgeOf(g.changes[0]).source
      staged.set(id, src ? place.keyOf(src) : ELSEWHERE)
      return
    }
    for (const c of g.changes) {
      const after = (c.after ?? {}) as Record<string, unknown>
      if (c.type === 'create_entity') staged.set(id, str(after.parentUrn) ? place.keyOf(after.parentUrn as string) : TOP)
      else if (c.type === 'move_entity') staged.set(id, str(after.parentId) ? place.keyOf(after.parentId as string) : TOP)
    }
  })

  const parentOf = new Map<string, string>()
  const containerOf = (id: string, changed: boolean): string => {
    const s = staged.get(id)
    if (s !== undefined) return s
    const p = place.parentOf(id)
    if (p === undefined) return changed ? ELSEWHERE : TOP      // an ancestor not known further up: the top
    return p === null ? TOP : place.keyOf(p)
  }
  for (const id of groupOf.keys()) {
    let at = id
    for (let depth = 0; depth < 64 && !parentOf.has(at); depth++) {
      const up = containerOf(at, groupOf.has(at))
      parentOf.set(at, up === at ? TOP : up)
      if (up === ELSEWHERE || up === LAYOUT) parentOf.set(up, TOP)
      if (up === TOP || up === ELSEWHERE || up === LAYOUT || parentOf.has(up)) break
      at = up
    }
  }

  // Each change counts in every container above it — a cycle in bad data stops at 64.
  const rollup = new Map<string, [number, number, number]>()
  for (const g of groups) {
    const slot = SLOT[g.status]
    let at = parentOf.get(treeIdOf(g))
    for (let depth = 0; at !== undefined && at !== TOP && depth < 64; depth++) {
      let r = rollup.get(at)
      if (!r) rollup.set(at, (r = [0, 0, 0]))
      r[slot]++
      at = parentOf.get(at)
    }
  }

  const nameOf = (id: string) => {
    if (id === ELSEWHERE) return 'Elsewhere in the graph'
    if (id === LAYOUT) return "This view's layout"
    const i = groupOf.get(id)
    return i !== undefined ? groups[i].name : place.nameOf(id)
  }
  const typeOf = (id: string) => {
    if (id === ELSEWHERE) return 'Not loaded on the canvas'
    if (id === LAYOUT) return 'Saved with the view'
    const i = groupOf.get(id)
    return i !== undefined ? groups[i].typeId : place.typeOf(id)
  }
  const kids = new Map<string, string[]>()
  for (const [id, parent] of parentOf) {
    let list = kids.get(parent)
    if (!list) kids.set(parent, (list = []))
    list.push(id)
  }
  const inside = (id: string) => { const r = rollup.get(id); return r ? r[0] + r[1] + r[2] : 0 }
  const order = (id: string) => (id === LAYOUT ? 3 : id === ELSEWHERE ? 2 : id.startsWith('edge:') ? 1 : 0)
  const rank = new Map<string, number>()
  for (const [parent, list] of kids) {
    const named = list.map((id) => ({ id, o: order(id), n: inside(id), name: nameOf(id).toLowerCase() }))
    named.sort((a, b) => a.o - b.o || b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1))
    const sorted = named.map((x) => x.id)
    kids.set(parent, sorted)
    sorted.forEach((id, at) => rank.set(id, at))
  }
  const tree: ReviewTree = { children: kids, parentOf, rollup, groupOf, rank, nameOf, typeOf }
  cache.set(groups, tree)
  return tree
}

/** Its containers from the top down, itself not included. */
export function pathOf(tree: ReviewTree, id: string): string[] {
  const out: string[] = []
  let at = tree.parentOf.get(id)
  while (at !== undefined && at !== TOP && out.length < 64) {
    out.unshift(at)
    at = tree.parentOf.get(at)
  }
  return out
}
