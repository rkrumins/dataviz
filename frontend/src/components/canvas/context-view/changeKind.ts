/**
 * The two kinds of change a move makes, said the same way on every surface (the graph is the
 * truth; a view is a lens over it):
 *
 *   • DATA — the entity moves under another parent in the graph. Ontology-checked, staged in the
 *     draft, saved by Review & Save, and shown in EVERY view that has the entity — for everyone,
 *     once the draft is published.
 *   • VIEW — where this view shows it (a column, an order, a group, a placement). Only this view
 *     changes; the data is untouched.
 *
 * `ChangeKindTag` (DropHint.tsx) draws the kind; these are its words, and the sentences the move
 * menus, the move dialog, the drawer, the notices and Review & Save build from them.
 */
import type { PersonaMode } from '@/store/persona'
import type { ViewLayerConfig } from '@/types/schema'
import { columnKind, type ColumnKind } from './columnKind'
import type { MoveVerdict } from './useReparentNode'

/** Who a data change reaches beyond this view. Counted from the views the reader can see (never
 *  more): other people's private views on the same data source follow too, unnamed and uncounted. */
export interface DataReach {
  /** Views on this view's data source the reader can see, besides this one. */
  otherViews: number
  /** The data source, by its display name. */
  source?: string
  sourceId?: string
  /** In a draft the other views follow once it is published; on main, once saved. */
  inDraft: boolean
}

/** Nothing known beyond this view — a move is a draft's change. */
export const NO_REACH: DataReach = { otherViews: 0, inDraft: true }

export const CHANGES_THE_DATA = 'Changes the data'
export const ONLY_THIS_VIEW = 'Only this view'

const sourceOf = (r: DataReach) => r.source ?? 'this data source'
const otherViews = (n: number) => `${n.toLocaleString()} other view${n === 1 ? '' : 's'}`
const whenOthersFollow = (r: DataReach) => (r.inDraft ? 'once published' : 'once saved')

/** Where a data change shows: "every view", or "this view and 3 others on Retail data pipeline". */
export function dataReachDetail(r: DataReach): string {
  const n = r.otherViews
  return n > 0 ? `this view and ${n.toLocaleString()} other${n === 1 ? '' : 's'} on ${sourceOf(r)}` : 'every view'
}

/** The data tag as a line of text: "Changes the data · every view". */
export const dataTagText = (r: DataReach) => `${CHANGES_THE_DATA} · ${dataReachDetail(r)}`

/** The honest small print under a count of other views: only those the reader can see are counted. */
export function reachNote(r: DataReach, persona: PersonaMode): string | undefined {
  if (r.otherViews === 0) return undefined
  const id = persona === 'technical' && r.sourceId ? ` Data source: ${r.sourceId}` : ''
  return `Counted from the views you can see — others’ private views follow too.${id}`
}

/** After what a data move did: who it reaches, and when. */
export function dataNoticeTail(r: DataReach): string {
  return r.otherViews > 0
    ? `A data change — this view now, and ${otherViews(r.otherViews)} on ${sourceOf(r)} ${whenOthersFollow(r)}.`
    : `A data change — every view that shows it, ${whenOthersFollow(r)}.`
}

/** The move dialog's body: what moves, and where it shows. */
export function moveDialogBody(name: string, r: DataReach): string {
  return `This changes the data: ${name} and everything inside it move under the parent you pick — in every view that shows it, ${whenOthersFollow(r)}. Its lineage stays as it is.`
}

/** The move dialog's word on the other views of the data source — none when none are known. */
export function moveDialogReach(name: string, r: DataReach): string | undefined {
  if (r.otherViews === 0) return undefined
  return `${sourceOf(r)} has ${otherViews(r.otherViews)}. Each one that shows ${name} will show it under the new parent ${whenOthersFollow(r)}.`
}

/** The drawer's line under "Move to a different parent". */
export function moveReachLine(r: DataReach): string {
  return r.otherViews > 0
    ? `It and everything inside it move — in this view now, and in ${otherViews(r.otherViews)} on ${sourceOf(r)} ${whenOthersFollow(r)}.`
    : `It and everything inside it move — in every view that shows it, ${whenOthersFollow(r)}.`
}

/** Move to Layer's footer: the two kinds, side by side. */
export function moveFooter(r: DataReach): string {
  const where = r.otherViews > 0 ? `this view and every other view on ${sourceOf(r)}` : 'every view'
  return `Only this view: the data doesn’t change. Changes the data: it moves in ${where} ${whenOthersFollow(r)}.`
}

/** After a view change: what it did (`done`), that only this view changed, and what followed it. */
export function viewNotice(done: string, followers = 0): string {
  const follow = followers > 0
    ? ` ${followers.toLocaleString()} placed inside it now follow${followers === 1 ? 's' : ''} it.`
    : ''
  return `${done} Only this view — the data is unchanged.${follow}`
}

/** One row of Move to Layer: a column, and what choosing it does with the entity. */
export interface ColumnChoice {
  layerId: string
  color?: string
  column: ColumnKind
  change: 'data' | 'view'
  label: string
  /** Set when it can't be chosen, saying why ("Shown here", "Already inside Finance", a refusal). */
  hint?: string
  /** A data choice's new parent: the entity the column is mapped to. */
  parentId?: string
}

/**
 * What each column would do with `entityId`. A column mapped to an entity offers two: move inside
 * that entity (a data change, as `verdict` judges it) or show it in the column (a view change).
 * Every other column only shows it there. The column it is drawn in now is "Shown here".
 */
export function columnChoices(
  layers: ReadonlyArray<Pick<ViewLayerConfig, 'id' | 'name' | 'color' | 'anchorUrn' | 'entityTypes' | 'rules'>>,
  opts: {
    entityId: string
    /** The column it is drawn in. */
    shownIn?: string
    /** A mapped column's entity — as its header resolves it: loaded, not missing, not another column's. */
    anchorOf: (layer: Pick<ViewLayerConfig, 'id' | 'anchorUrn'>) => { id: string; name: string } | undefined
    /** What moving it inside `parentId` would do. */
    verdict: (parentId: string) => MoveVerdict
  },
): ColumnChoice[] {
  const out: ColumnChoice[] = []
  for (const layer of layers) {
    const anchor = layer.anchorUrn ? opts.anchorOf(layer) : undefined
    const column = columnKind(layer, { resolved: !!anchor })
    const shownHere = opts.shownIn === layer.id ? 'Shown here' : undefined
    const base = { layerId: layer.id, color: layer.color, column }
    if (column === 'mapped' && anchor && anchor.id !== opts.entityId) {
      const v = opts.verdict(anchor.id)
      out.push({
        ...base, change: 'data', label: `Move inside ${anchor.name}`, parentId: anchor.id,
        hint: v.kind === 'data' ? undefined : v.kind === 'blocked' ? v.hint : `Already inside ${anchor.name}`,
      })
    }
    out.push({
      ...base, change: 'view', label: column === 'mapped' ? `Show in ${layer.name} column` : `Show in ${layer.name}`, hint: shownHere,
    })
  }
  return out
}
