/**
 * reviewModel — staged changes as a person reads them, for Review & Save.
 *
 * One group per thing changed (an entity, a relationship, a view-layout item), each with a sentence
 * ("Renamed *orders* to *Orders v2*", "Connected *A* → *B* as feeds") and, on demand, the fields it
 * changes — only the ones the save will send (`nodeUpdatePatch`), named the way the drawer names
 * them, never the whole node twice. Where a change carries too little to say more, its own summary
 * is the sentence.
 *
 * Pure: names come from the caller (`nameOf`), so it is cheap to rebuild and easy to test.
 */
import { stagedChangeColor, type StagedChange, type StagedChangeType } from '@/store/stagedChangesStore'
import { toPayloadShape } from '@/lib/nodeFields'
import { nodeUpdatePatch, propertiesPatch } from './stagedChangesToOps'
import type { ChangeStatus } from './changeModel'
import { fieldLabel, propertyChange as property, type FieldChange } from './fieldDiff'

export type { FieldChange }

/** A sentence: plain words, and names to set in bold. */
export type Sentence = (string | { name: string })[]

export type ReviewKind = 'node' | 'edge' | 'layout'

export interface ReviewGroup {
  /** Stable: the entity's urn / the edge's id / the change's id. */
  key: string
  kind: ReviewKind
  name: string
  /** The entity's type, for its colour. */
  typeId?: string
  /** A relationship's type. */
  edgeType?: string
  status: ChangeStatus
  changes: StagedChange[]
  sentence: Sentence
  /** The canvas node to jump to, if there is one. */
  revealId?: string
}

export interface NameLookup {
  /** An entity's display name by its id or urn (falls back to the id). */
  nameOf: (id: string) => string
  /** An entity's type by its id or urn. */
  typeOf?: (id: string) => string | undefined
}

/** View-layout changes: presentation only, they never touch the data source. */
export const LAYOUT_TYPES: ReadonlySet<StagedChangeType> = new Set(['layer_config', 'assign_layer', 'move_to_layer', 'reorder_nodes'])

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

const labelOf = (d: Record<string, unknown>) => str(d.label) ?? str(d.displayName) ?? str(d.name)

function statusOf(type: StagedChangeType): ChangeStatus {
  const c = stagedChangeColor(type)
  return c === 'green' ? 'added' : c === 'red' ? 'removed' : 'modified'
}

/** The edge a change is about, in whichever shape its surface staged it. */
function edgeOf(change: StagedChange): { source?: string; target?: string; type?: string } {
  const after = asObj(change.after)
  const before = asObj(change.before)
  const e = change.type === 'create_edge' ? after : asObj(before.edge ?? before)
  const data = asObj(e.data)
  return {
    source: str(e.source) ?? str(e.sourceUrn),
    target: str(e.target) ?? str(e.targetUrn),
    type: str(e.edgeType) ?? str(data.edgeType) ?? str(data.relationship) ?? str(e.type),
  }
}

/** The fields a node edit changes, as the save will send them. */
export function fieldChanges(change: StagedChange): FieldChange[] {
  if (change.type === 'edit_edge') {
    const b = asObj(asObj(change.before).properties)
    const a = asObj(asObj(change.after).properties)
    const { set, unset } = propertiesPatch(b, a)
    return [
      ...Object.entries(set).map(([k, v]) => property(k, b[k], v, k in b ? 'changed' : 'added')),
      ...unset.map((k) => property(k, b[k], undefined, 'removed')),
    ]
  }
  if (change.type !== 'update_entity' && change.type !== 'rename_entity') return []
  const { payload, unset } = nodeUpdatePatch(change.before, change.after)
  const before = toPayloadShape(change.before)
  const out: FieldChange[] = []
  for (const [field, after] of Object.entries(payload)) {
    if (field === 'properties') continue
    const was = (before as Record<string, unknown>)[field]
    out.push({ label: fieldLabel(field) ?? field, before: was, after, kind: was === undefined || was === '' ? 'added' : 'changed' })
  }
  const props = before.properties ?? {}
  for (const [k, v] of Object.entries(asObj(payload.properties))) out.push(property(k, props[k], v, k in props ? 'changed' : 'added'))
  for (const k of unset) out.push(property(k, props[k], undefined, 'removed'))
  return out
}

/** The sentence for one change — or its summary, where it carries too little to say more. */
export function sentenceFor(change: StagedChange, { nameOf }: NameLookup): Sentence {
  const after = asObj(change.after)
  const before = asObj(change.before)
  const id = change.targetUrn ?? change.targetId
  switch (change.type) {
    case 'create_entity': {
      const name = str(after.displayName)
      if (!name) break
      const parent = str(after.parentLabel) ?? (str(after.parentUrn) ? nameOf(after.parentUrn as string) : undefined)
      return parent ? ['Added ', { name }, ' inside ', { name: parent }] : ['Added ', { name }, ' at the top level']
    }
    case 'rename_entity': {
      const from = labelOf(before)
      const to = labelOf(after)
      if (!from || !to) break
      return ['Renamed ', { name: from }, ' to ', { name: to }]
    }
    case 'update_entity': {
      const n = fieldChanges(change).length
      const name = labelOf(before) ?? labelOf(after)
      if (!n || !name) break
      return [`Changed ${n} field${n === 1 ? '' : 's'} on `, { name }]
    }
    case 'delete_entity': {
      const node = asObj(before.node)
      const name = labelOf(asObj(node.data)) ?? (str(node.id) ? nameOf(node.id as string) : undefined)
      if (!name) break
      const cascade = asObj(before.cascade)
      const inside = Number(cascade.nodeTotal ?? 1) - 1
      const links = Number(cascade.edgeTotal ?? 0)
      const more = [inside > 0 && `${inside} item${inside === 1 ? '' : 's'} inside it`, links > 0 && `${links} relationship${links === 1 ? '' : 's'}`]
        .filter(Boolean).join(' and ')
      return more ? ['Deleted ', { name }, ` — with ${more}`] : ['Deleted ', { name }]
    }
    case 'move_entity': {
      const child = str(after.childId) ?? id
      if (!str(after.childId)) break
      const parent = str(after.parentId)
      return parent ? ['Moved ', { name: nameOf(child) }, ' inside ', { name: nameOf(parent) }] : ['Moved ', { name: nameOf(child) }, ' to the top level']
    }
    case 'create_edge':
    case 'delete_edge':
    case 'edit_edge':
    case 'reverse_edge': {
      const e = edgeOf(change)
      if (!e.source || !e.target) break
      const src = { name: nameOf(e.source) }
      const tgt = { name: nameOf(e.target) }
      const as = e.type ? ` as ${e.type}` : ''
      if (change.type === 'create_edge') return ['Connected ', src, ' → ', tgt, as]
      if (change.type === 'delete_edge') return ['Disconnected ', src, ' → ', tgt]
      if (change.type === 'reverse_edge') return ['Reversed ', src, ' → ', tgt, ' — it now runs from ', tgt]
      return ['Edited the link ', src, ' → ', tgt]
    }
    default:
      break
  }
  return [change.summary]
}

/** A group whose sentence is worded when first read — a 50,000-change review words only the rows
 *  drawn, not every change up front (a field edit's sentence diffs the node). */
class Group implements ReviewGroup {
  #lead: StagedChange
  #sentence: Sentence | null = null
  readonly #lookup: NameLookup
  key: string
  kind: ReviewKind
  name: string
  typeId?: string
  edgeType?: string
  status: ChangeStatus
  changes: StagedChange[]
  revealId?: string

  constructor(init: Omit<ReviewGroup, 'sentence'>, lookup: NameLookup) {
    this.key = init.key
    this.kind = init.kind
    this.name = init.name
    this.typeId = init.typeId
    this.edgeType = init.edgeType
    this.status = init.status
    this.changes = init.changes
    this.revealId = init.revealId
    this.#lead = init.changes[0]
    this.#lookup = lookup
  }

  /** A create or delete says more about the thing than an edit made to it as well. */
  lead(change: StagedChange) {
    this.status = statusOf(change.type)
    this.#lead = change
    this.#sentence = null
  }

  get sentence(): Sentence {
    return (this.#sentence ??= sentenceFor(this.#lead, this.#lookup))
  }
}

/** Every staged change, grouped by what it changes, in the order they were first made. */
export function buildReviewGroups(changes: readonly StagedChange[], lookup: NameLookup): ReviewGroup[] {
  const groups = new Map<string, Group>()
  for (const c of changes) {
    const layout = LAYOUT_TYPES.has(c.type)
    const kind: ReviewKind = layout ? 'layout' : c.type.includes('edge') ? 'edge' : 'node'
    const key = layout ? c.id : kind === 'node' && c.type === 'move_entity'
      ? (str(asObj(c.after).childId) ?? c.targetUrn ?? c.targetId)
      : (c.targetUrn ?? c.targetId)
    const existing = groups.get(`${kind}:${key}`)
    if (existing) {
      existing.changes.push(c)
      if (statusOf(c.type) !== 'modified') existing.lead(c)
      continue
    }
    // Named as the canvas names it — or, for an entity the canvas has not loaded (scrolled away, a
    // large draft), as the change itself does, never by its urn.
    const known = lookup.nameOf(key)
    const afterName = str(asObj(c.after).displayName)
      ?? (known !== key ? known : labelOf(asObj(c.after)) ?? labelOf(asObj(c.before)) ?? labelOf(asObj(asObj(asObj(c.before).node).data)))
    const ends = kind === 'edge' ? edgeOf(c) : null
    groups.set(`${kind}:${key}`, new Group({
      key,
      kind,
      name: kind === 'node' ? (afterName ?? lookup.nameOf(key))
        : ends?.source && ends.target ? `${lookup.nameOf(ends.source)} → ${lookup.nameOf(ends.target)}` : c.summary,
      typeId: kind === 'node' ? (str(asObj(c.after).entityType) ?? lookup.typeOf?.(key)) : undefined,
      edgeType: ends?.type,
      status: statusOf(c.type),
      changes: [c],
      revealId: kind === 'node' && c.type !== 'delete_entity' ? key : undefined,
    }, lookup))
  }
  return [...groups.values()]
}

/** "3 entities and 2 relationships" — what a review is about, in one phrase. */
export function describeScope(groups: readonly ReviewGroup[]): string {
  const n = { node: 0, edge: 0, layout: 0 }
  for (const g of groups) n[g.kind]++
  const parts = [
    n.node && `${n.node.toLocaleString()} ${n.node === 1 ? 'entity' : 'entities'}`,
    n.edge && `${n.edge.toLocaleString()} ${n.edge === 1 ? 'relationship' : 'relationships'}`,
    n.layout && `${n.layout.toLocaleString()} layout ${n.layout === 1 ? 'change' : 'changes'}`,
  ].filter(Boolean) as string[]
  return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** A title for the publish, from what was changed: "Update owner on Orders and 2 more". */
export function suggestTitle(groups: readonly ReviewGroup[]): string {
  const data = groups.filter((g) => g.kind !== 'layout')
  if (data.length === 0) return groups.length ? 'Update the view layout' : ''
  const first = data[0]
  const verb = first.status === 'added' ? 'Add' : first.status === 'removed' ? 'Remove' : 'Update'
  const fields = first.status === 'modified' ? first.changes.flatMap(fieldChanges).map((f) => f.label) : []
  const what = fields.length === 1 ? `${fields[0]} on ${first.name}` : first.name
  return data.length === 1 ? `${verb} ${what}` : `${verb} ${what} and ${data.length - 1} more`
}
