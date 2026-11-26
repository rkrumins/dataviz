/**
 * Deleting a column, said before it happens (DeleteColumnDialog), and taking an entity out of the
 * view (the entity menu). The graph is the truth and a view is a lens:
 *
 *   • removing the column is a VIEW change — each entity it shows then shows where its parent or a
 *     type column puts it, or leaves the view; what was placed in it by hand loses that place, and
 *     its groups go with it;
 *   • deleting its entities too is a DATA change — staged in the draft with everything inside them.
 *
 * Where each entity goes is read off the canvas's own placement run on the layout as it would be
 * (`PlacementAfter`), never guessed. These are the sums, and the words.
 */
import type { DeleteImpact } from '@/services/versioningApiService'
import type { DataReach } from './changeKind'

/** What the canvas would draw: each entity's column, and the entities drawn AS a column. */
export interface PlacementAfter {
  layerOf: ReadonlyMap<string, string>
  promoted: ReadonlyMap<string, string>
}

/** Where one entity shows once its column (or its placement) is gone. */
export type Fate =
  | { kind: 'parent'; layerId: string; parentId: string }
  | { kind: 'column'; layerId: string; byType: boolean }
  | { kind: 'gone' }

/** The column `id` would be drawn in after, if any. */
export const columnAfter = (id: string, after: PlacementAfter) => after.layerOf.get(id) ?? after.promoted.get(id)

/** Where `id` shows after: back under its parent (in the parent's column), a top-level row of
 *  another column — by its type when that column holds its type — or not at all. */
export function fateOf(
  id: string,
  after: PlacementAfter,
  parentOf: (id: string) => string | undefined,
  holdsType: (layerId: string, id: string) => boolean,
): Fate {
  const to = columnAfter(id, after)
  if (!to) return { kind: 'gone' }
  const parent = parentOf(id)
  if (parent && columnAfter(parent, after) === to) return { kind: 'parent', layerId: to, parentId: parent }
  return { kind: 'column', layerId: to, byType: holdsType(to, id) }
}

/** A line of the dialog, with what kind of thing it says (its icon). */
export interface ImpactLine {
  kind: 'parent' | 'column' | 'gone' | 'placed' | 'groups' | 'count' | 'new' | 'also' | 'note' | 'blocked'
  text: string
}

const NAMES_SHOWN = 4

/** "Ops", "Lab and Ops", "A, B, C, D and 3 more" — sorted, as the column sorts them. */
export function namesOf(names: readonly string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  if (sorted.length > NAMES_SHOWN + 1) return `${sorted.slice(0, NAMES_SHOWN).join(', ')} and ${(sorted.length - NAMES_SHOWN).toLocaleString()} more`
  return sorted.length <= 1 ? (sorted[0] ?? '') : `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`
}

const its = (n: number) => (n === 1 ? 'its' : 'their')
const entities = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'entity' : 'entities'}`
const relationships = (n: number) => (n === 0 ? 'no relationships' : `${n.toLocaleString()} relationship${n === 1 ? '' : 's'}`)

/** What removing the column does with what it shows: one line per place they go, then nowhere. */
export function fateLines(
  fates: ReadonlyArray<{ id: string; fate: Fate }>,
  nameOf: (id: string) => string,
  columnOf: (layerId: string) => string,
): ImpactLine[] {
  const group = new Map<string, { fate: Fate; ids: string[] }>()
  for (const { id, fate } of fates) {
    const key = fate.kind === 'gone' ? 'gone' : `${fate.kind}:${fate.layerId}:${fate.kind === 'column' && fate.byType}`
    const at = group.get(key)
    if (at) at.ids.push(id)
    else group.set(key, { fate, ids: [id] })
  }
  const lines: ImpactLine[] = []
  const gone: string[] = []
  for (const { fate, ids } of group.values()) {
    const names = namesOf(ids.map(nameOf))
    if (fate.kind === 'gone') { gone.push(...ids); continue }
    const column = columnOf(fate.layerId)
    if (fate.kind === 'parent') {
      lines.push({
        kind: 'parent',
        text: ids.length === 1
          ? `${names} will go back under its parent, ${nameOf(fate.parentId)}, in ${column}.`
          : `${names} will go back under their parents in ${column}.`,
      })
    } else {
      lines.push({ kind: 'column', text: `${names} will show in ${column}${fate.byType ? `, by ${its(ids.length)} type` : ''}.` })
    }
  }
  if (gone.length > 0) lines.push({ kind: 'gone', text: `${namesOf(gone.map(nameOf))} won’t be in this view.` })
  return lines
}

/** Hand placements lose their place with the column. */
export function placedLine(n: number): ImpactLine[] {
  if (n === 0) return []
  return [{ kind: 'placed', text: n === 1 ? 'The one entity placed here by hand loses that place.' : `The ${n.toLocaleString()} entities placed here by hand lose that place.` }]
}

/** Its groups — and the groups inside them — go with it. */
export function groupsLine(names: readonly string[]): ImpactLine[] {
  if (names.length === 0) return []
  const list = names.length <= 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return [{ kind: 'groups', text: names.length === 1 ? `Its group ${list} goes with it.` : `Its groups ${list} go with it.` }]
}

/** What deleting from the data takes, as the delete-impact reads say: the entities, what is inside
 *  them, and every relationship they have — each counted once, however many reads name it. */
export interface DeleteTotals {
  entities: number
  inside: number
  relationships: number
}

export function deleteTotals(
  saved: readonly string[],
  impacts: ReadonlyMap<string, DeleteImpact>,
  fresh: { count: number; inside: number },
): DeleteTotals {
  const nodes = new Set<string>()
  const edges = new Set<string>()
  let nodesUnlisted = 0
  let edgesUnlisted = 0
  for (const urn of saved) {
    const impact = impacts.get(urn)
    if (!impact) { nodes.add(urn); continue }
    for (const n of impact.nodes) nodes.add(String(n.urn ?? n.entityId))
    for (const e of impact.edges) edges.add(String(e.entityId ?? e.id))
    // The lists are capped; the totals are not.
    nodesUnlisted += Math.max(0, impact.nodeTotal - impact.nodes.length)
    edgesUnlisted += Math.max(0, impact.edgeTotal - impact.edges.length)
  }
  return {
    entities: saved.length + fresh.count,
    inside: Math.max(0, nodes.size + nodesUnlisted - saved.length) + fresh.inside,
    relationships: edges.size + edgesUnlisted,
  }
}

/** The count line: "2 entities and 3 inside them; 6 relationships." — or, for a column that is
 *  one entity, "Finance and 2 inside it; 3 relationships." Without a count: what goes with them. */
export function countLine(totals: DeleteTotals | null, n: number, mapped?: string): ImpactLine {
  const what = mapped ?? entities(n)
  const them = mapped || n === 1 ? 'it' : 'them'
  if (!totals) return { kind: 'count', text: `${what}, with everything inside ${them}.` }
  const inside = totals.inside > 0 ? ` and ${totals.inside.toLocaleString()} inside ${them}` : ''
  return { kind: 'count', text: `${mapped ?? entities(totals.entities)}${inside}; ${relationships(totals.relationships)}.` }
}

/** Entities new in this draft are not deleted: their creates are discarded. */
export function newLine(n: number, mapped?: string): ImpactLine[] {
  if (n === 0) return []
  if (mapped) return [{ kind: 'new', text: `${mapped} is new in this draft — its create is discarded instead.` }]
  return [{ kind: 'new', text: n === 1 ? '1 is new in this draft — its create is discarded instead.' : `${n.toLocaleString()} are new in this draft — their creates are discarded instead.` }]
}

/** What is inside them but drawn in other columns goes too — said, so it is no surprise there. */
export function alsoLine(also: ReadonlyArray<{ name: string; column: string }>, n: number, mapped?: boolean): ImpactLine[] {
  if (also.length === 0) return []
  const columns = [...new Set(also.map((a) => a.column))]
  const where = columns.length === 1 ? columns[0] : 'other columns'
  return [{ kind: 'also', text: `Also deletes ${namesOf(also.map((a) => a.name))}, inside ${mapped || n === 1 ? 'it' : 'them'} but shown in ${where}.` }]
}

/** When a data delete happens, and when the views its tag names follow it. */
export function stagedDeleteNote(r: DataReach): ImpactLine {
  return {
    kind: 'note',
    text: `Staged in this draft — nothing is deleted until you save it; ${r.otherViews > 0 ? 'the other views follow' : 'every view follows'} once it’s published.`,
  }
}

/** The data choice's button: "Delete 2 entities", "Delete Finance". */
export const deleteDataLabel = (n: number, mapped?: string) => `Delete ${mapped ?? entities(n)}`

/** The ids among `ids` that no other one of them holds (walking up `parentOf`) — a delete of the
 *  outer one takes the inner one with it. */
export function outermostOf(ids: readonly string[], parentOf: (id: string) => string | undefined): string[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    const seen = new Set<string>()
    for (let up = parentOf(id); up && !seen.has(up); up = parentOf(up)) {
      if (set.has(up)) return false
      seen.add(up)
    }
    return true
  })
}
