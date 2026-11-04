/**
 * Subset views — what the screens share: whether a search can be kept, the
 * layers a subset shows (its base's, each match where the base places it), the
 * request saving one becomes,
 * the counts a preview asks for, and the words for a layer's matches.
 *
 * Pure: no React, no store. The wire types are `@/types/searchView`; the layer
 * rules mirror `backend/app/services/search_views.py`, which is the authority.
 */
import type { MembershipSpec } from '@/types/membership'
import type { Predicate } from '@/types/search'
import type {
  FromSearchRequest,
  SearchViewDefinition,
  SearchViewStatus,
  SubsetInclude,
  SubsetLayer,
  SubsetLayerSpec,
  SubsetLayout,
  SubsetWithin,
} from '@/types/searchView'
import { NO_INCLUDE, REST_LAYER_ID } from '@/types/searchView'

/** Layers of types a subset's own layout may have, and the types one may name. */
export const LAYERS_MAX = 12
export const LAYER_TYPES_MAX = 32
export const REST_LAYER_NAME = 'Other matches'

type Node = Record<string, unknown> & { kind?: string }

// ── Whether a search can be kept ───────────────────────────────────────────

/** Why ``predicate`` can't be kept as a subset view, in the user's words; null
 *  when it can. A subset view asks its search of one entity at a time, finds
 *  entities (not edges), and takes its layers from its base. */
const LINEAGE_AXES = new Set(['upstream', 'downstream', 'neighbor'])

export function unsaveableReason(predicate: Predicate | null | undefined): string | null {
  if (!predicate) return 'Run a search first.'
  const root = unwrapEdges(predicate as unknown as Node)
  if (root.kind === 'edges') return 'A Connections search finds connections — a subset view shows entities.'
  let reason: string | null = null
  walk(root, (node) => {
    if (reason) return
    if (node.kind === 'layer') {
      reason = 'A subset view’s layers come from its base, so its search can’t filter by layer.'
    } else if (node.kind === 'path' || node.kind === 'withinHops') {
      reason = 'A route through the graph can’t be kept: a subset view asks its search of one entity at a time.'
    } else if (node.kind === 'related' && LINEAGE_AXES.has(String(node.axis))
      && (Number(node.maxHops ?? 1) > 1 || Number(node.minHops ?? 1) > 1)) {
      // As the server refuses it (`view_library._check_predicate`, rule-shaped).
      reason = 'A search that follows lineage more than one step can’t be kept yet: a subset view asks its search of every entity.'
    }
  })
  return reason
}

function unwrapEdges(node: Node): Node {
  const children = node.children as Node[] | undefined
  if (node.kind === 'group' && node.op === 'and' && children?.length === 1 && children[0].kind === 'edges') {
    return children[0]
  }
  return node
}

function walk(node: Node | undefined, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of (node.children as Node[] | undefined) ?? []) walk(child, visit)
  for (const key of ['where', 'sourceWhere', 'targetWhere'] as const) {
    if (node[key] && typeof node[key] === 'object') walk(node[key] as Node, visit)
  }
}

// ── Layers ──────────────────────────────────────────────────────────────────

export interface BoardLayer {
  id: string
  name?: string
  color?: string
  order?: number
  entityTypes?: string[]
  showUnassigned?: boolean
}

const fold = (t: string) => t.toLocaleLowerCase()

function ordered(layers: BoardLayer[]): BoardLayer[] {
  return layers
    .map((layer, position) => ({ layer, position }))
    .filter(({ layer }) => typeof layer.id === 'string' && layer.id)
    .sort((a, b) => (finite(a.layer.order) - finite(b.layer.order)) || (a.position - b.position))
    .map(({ layer }) => layer)
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The layers a board shows, as a subset shows them: each with the types it owns —
 *  claimed first, in board order — and the fallback layer (the first with
 *  `showUnassigned`, or an "Other matches" one) with every type no other layer owns. */
export function layersLike(board: BoardLayer[], { addRest = true } = {}): SubsetLayer[] {
  const layers = ordered(board)
  const owner = new Map<string, string>()
  for (const layer of layers) {
    for (const t of new Set(layer.entityTypes ?? [])) if (t && !owner.has(fold(t))) owner.set(fold(t), layer.id)
  }
  let restId = layers.find((l) => l.showUnassigned === true)?.id ?? null
  const out: SubsetLayer[] = layers.map((layer) => ({
    id: layer.id,
    name: layer.name || layer.id,
    color: layer.color ?? null,
    entityTypes: [...new Set(layer.entityTypes ?? [])].filter((t) => t && owner.get(fold(t)) === layer.id),
    rest: layer.id === restId,
    excludedTypes: [],
  }))
  if (restId === null && addRest) {
    out.push({ id: REST_LAYER_ID, name: REST_LAYER_NAME, entityTypes: [], rest: true, excludedTypes: [] })
    restId = REST_LAYER_ID
  }
  const claimed = [...new Map(out.flatMap((l) => l.entityTypes.map((t) => [fold(t), t] as const))).values()]
  return out.map((l) => (l.rest
    ? { ...l, excludedTypes: claimed.filter((t) => !l.entityTypes.some((o) => fold(o) === fold(t))) }
    : l))
}

/** What a match must also meet to be in ``layer``: one of its types — or, for the
 *  rest layer, none of the types the others own. Null: the layer holds nothing. */
export function layerCondition(layer: SubsetLayer): Node | null {
  if (layer.rest) return layer.excludedTypes.length ? typesNode('notIn', layer.excludedTypes) : { kind: 'all' }
  return layer.entityTypes.length ? typesNode('in', layer.entityTypes) : null
}

function typesNode(op: 'in' | 'notIn', types: string[]): Node {
  const chunks: string[][] = []
  for (let i = 0; i < types.length; i += LAYER_TYPES_MAX) chunks.push(types.slice(i, i + LAYER_TYPES_MAX))
  const leaves = chunks.map((values) => ({ kind: 'entityType', op, values }))
  return leaves.length === 1 ? leaves[0] : { kind: 'group', op: op === 'in' ? 'or' : 'and', children: leaves }
}

/** ``predicate`` and the layer's condition: what a preview counts for the layer. */
export function layerPredicate(predicate: Predicate, layer: SubsetLayer): Predicate | null {
  const condition = layerCondition(layer)
  if (condition === null) return null
  if (condition.kind === 'all') return predicate
  return { kind: 'group', op: 'and', children: [predicate, condition] } as unknown as Predicate
}

/** Subset layers as an own layout stores them: layers of types, and the rest's name. */
export function ownLayersFrom(layers: SubsetLayer[]): { layers: SubsetLayerSpec[]; rest: string | null } {
  const typed = layers.filter((l) => !l.rest && l.entityTypes.length > 0).slice(0, LAYERS_MAX)
  const rest = layers.find((l) => l.rest)
  return {
    layers: typed.map((l) => ({ name: l.name, ...(l.color ? { color: l.color } : {}), entityTypes: l.entityTypes.slice(0, LAYER_TYPES_MAX) })),
    rest: rest ? rest.name : null,
  }
}

/** One layer per type found, the most common first — at most twelve — and the rest. */
export function perTypeLayers(found: Array<{ type: string; count: number }>, label: (type: string) => string = (t) => t):
  { layers: SubsetLayerSpec[]; rest: string } {
  const types = [...found].filter((f) => f.count > 0).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  return {
    layers: types.slice(0, LAYERS_MAX).map((f) => ({ name: label(f.type), entityTypes: [f.type] })),
    rest: REST_LAYER_NAME,
  }
}

// ── What it keeps beside the matches ───────────────────────────────────────

/** One of what a subset keeps beside its matches, each on or off. */
export type IncludeChoice = 'contents' | 'containers' | 'upstream' | 'downstream'

export function anyIncluded(include: SubsetInclude | null | undefined): boolean {
  return !!include && (include.contents || include.containers || include.upstream || include.downstream)
}

/** Kinds as the server keeps them: a set, sorted; none named is every kind. */
function kindsOf(kinds: string[] | null | undefined): string[] | undefined {
  const set = [...new Set((kinds ?? []).filter(Boolean))].sort()
  return set.length ? set : undefined
}

/** ``include`` as the server keeps it (`SubsetInclude`'s own rules): levels and
 *  kinds only with the choice they go with, kinds a set, nothing unset sent. */
export function keptInclude(include: SubsetInclude): SubsetInclude {
  const { contents, containers, upstream, downstream } = include
  const contentsKinds = contents ? kindsOf(include.contentsKinds) : undefined
  const containersKinds = containers ? kindsOf(include.containersKinds) : undefined
  return {
    contents,
    ...(contents && include.contentsLevels ? { contentsLevels: include.contentsLevels } : {}),
    ...(contentsKinds ? { contentsKinds } : {}),
    containers,
    ...(containers && include.containersLevels ? { containersLevels: include.containersLevels } : {}),
    ...(containersKinds ? { containersKinds } : {}),
    upstream,
    downstream,
  }
}

/** Inside a match (``ancestor``) or containing one (``descendant``), ``levels`` of
 *  the way (unset: the whole way), of ``kinds`` when some are named — the kind
 *  first, so a candidate of another kind is never walked (`_of_kinds`). */
function containment(axis: 'ancestor' | 'descendant', where: Predicate, levels?: number, kinds?: string[]): Node {
  const related: Node = { kind: 'related', axis, where, ...(levels ? { maxHops: levels } : {}) }
  const only = kindsOf(kinds)
  return only ? { kind: 'group', op: 'and', children: [{ kind: 'entityType', op: 'in', values: only }, related] } : related
}

/** What a subset's entities are found by: its search, or its search and what it
 *  includes — composed as the server composes it (`search_predicate`), so a
 *  preview counts what the view will hold. A lineage step is taken from a match
 *  or anything inside it, as a trace walks a container. */
export function withInclude(predicate: Predicate, include: SubsetInclude | null | undefined): Predicate {
  if (!include || !anyIncluded(include)) return predicate
  const parts: Node[] = [predicate as unknown as Node]
  if (include.contents) parts.push(containment('ancestor', predicate, include.contentsLevels, include.contentsKinds))
  if (include.containers) parts.push(containment('descendant', predicate, include.containersLevels, include.containersKinds))
  const reach = { kind: 'group', op: 'or', children: [predicate, { kind: 'related', axis: 'ancestor', where: predicate }] }
  if (include.upstream) parts.push({ kind: 'related', axis: 'downstream', where: reach })
  if (include.downstream) parts.push({ kind: 'related', axis: 'upstream', where: reach })
  return { kind: 'group', op: 'or', children: parts } as unknown as Predicate
}

const LEVEL_WORDS = ['', 'one level', 'two levels', 'three levels']

/** "two levels" — a number of levels, as the server says it. */
export function levelsText(levels: number): string {
  return LEVEL_WORDS[levels] ?? `${levels} levels`
}

/** "two levels inside them (only Column) and what feeds them" — what a subset keeps
 *  beside its matches, in words, as the server says how far; '' for just the matches. */
export function includeWords(include: SubsetInclude | null | undefined,
  typeLabel: (type: string) => string = (t) => t): string {
  if (!include) return ''
  const only = (words: string, kinds?: string[]) => {
    const named = kindsOf(kinds)
    return named ? `${words} (only ${list(named.map(typeLabel))})` : words
  }
  const words = [
    include.contents && only(include.contentsLevels
      ? `${levelsText(include.contentsLevels)} inside them` : 'everything inside them', include.contentsKinds),
    include.containers && only(include.containersLevels
      ? `what contains them, ${levelsText(include.containersLevels)} up` : 'what contains them', include.containersKinds),
    include.upstream && 'what feeds them',
    include.downstream && 'what they feed',
  ].filter((w): w is string => !!w)
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** A narrowing kept live, as a subset view: its search, where it looks, and what it
 *  includes — or why it can only be kept as a list of members. A live view keeps
 *  every level inside the matches or a number of them, and one lineage step either way. */
export function liveFromNarrowing(spec: MembershipSpec):
  { predicate: Predicate; within: SubsetWithin; include: SubsetInclude } | { reason: string } {
  const query = spec.seeds.query
  if (!query) return { reason: 'It starts from chosen entities, not a search, so it is kept as a list of them.' }
  const blocked = unsaveableReason(query)
  if (blocked) return { reason: blocked }
  const { children, upstream, downstream, partnerChildren } = spec.expand
  if ((upstream !== 0 && upstream !== 1) || (downstream !== 0 && downstream !== 1)) {
    return { reason: 'It reaches more than one step of lineage. Kept live, it reaches one step either way.' }
  }
  if (partnerChildren !== 0) {
    return { reason: 'It keeps what is inside its sources and consumers, which only a list of them can.' }
  }
  return {
    predicate: query,
    within: spec.within,
    include: { ...NO_INCLUDE, contents: children !== 0, ...(children !== 'all' && children ? { contentsLevels: children } : {}),
      upstream: upstream === 1, downstream: downstream === 1 },
  }
}

// ── The request a search becomes ───────────────────────────────────────────

export type LayoutChoice = 'like' | 'perType' | 'one'

export interface SaveSearchChoices {
  name: string
  visibility: FromSearchRequest['visibility']
  within: SubsetWithin
  choice: LayoutChoice
  /** What it keeps beside the matches. */
  include?: SubsetInclude
  /** The base layers a subset that follows its base leaves out, with their matches
   *  (their ids, or `other-matches`). */
  hidden?: string[]
}

export interface SaveSearchContext {
  workspaceId: string
  dataSourceId?: string | null
  /** The view the search was run in: the base of a subset of a view. */
  viewId: string
  /** The search as it will be kept (``combinedWith`` from inside a subset view). */
  predicate: Predicate
  /** The base's board, for "Like" a whole-data-source search copies. */
  baseLayers: BoardLayer[]
  /** The types the search found, for "A layer per type found". */
  typeCounts: Array<{ type: string; count: number }>
  typeLabel?: (type: string) => string
}

export function requestOf(choices: SaveSearchChoices, ctx: SaveSearchContext): FromSearchRequest {
  const inView = choices.within === 'view'
  let layout: SubsetLayout = 'own'
  let layers: SubsetLayerSpec[] | undefined
  let rest: string | null | undefined
  if (choices.choice === 'like' && inView) {
    // It follows its base: what it leaves out is named, so new base layers still arrive.
    layout = 'inherit'
  } else if (choices.choice === 'like') {
    ({ layers, rest } = ownLayersFrom(layersLike(ctx.baseLayers)))
  } else if (choices.choice === 'perType') {
    ({ layers, rest } = perTypeLayers(ctx.typeCounts, ctx.typeLabel))
  } else {
    layers = []
    rest = 'Matches'
  }
  // Only a subset that follows its base leaves layers out: an own layout's left-out
  // type would belong to no layer, and its matches would land in "Other matches".
  const hidden = layout === 'inherit' ? [...new Set(choices.hidden ?? [])] : []
  return {
    name: choices.name.trim(),
    visibility: choices.visibility,
    workspaceId: ctx.workspaceId,
    dataSourceId: ctx.dataSourceId ?? null,
    predicate: ctx.predicate,
    within: choices.within,
    ...(inView ? { readIn: ctx.viewId } : {}),
    layout,
    ...(layout === 'own' ? { layers, rest } : {}),
    ...(hidden.length ? { hiddenLayers: hidden } : {}),
    ...(choices.include && anyIncluded(choices.include) ? { include: keptInclude(choices.include) } : {}),
    provenance: { origin: 'search', viewId: ctx.viewId },
  }
}

/** Saving from inside a subset view: its search and the one just run, against the
 *  same base — a subset of a subset is its base's, with both searches. */
export function combinedWith(
  subset: SearchViewDefinition | null | undefined, predicate: Predicate, viewId: string,
): { predicate: Predicate; baseViewId: string } {
  if (!subset) return { predicate, baseViewId: viewId }
  return {
    predicate: { kind: 'group', op: 'and', children: [subset.predicate, predicate] } as unknown as Predicate,
    baseViewId: subset.readIn ?? viewId,
  }
}

/** A name from the search's own words. */
export function nameFrom(sentence: string | null | undefined, fallback = 'Search results'): string {
  const text = (sentence ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text
}

// ── A layer's matches, in words ────────────────────────────────────────────

const number = new Intl.NumberFormat()

export interface FeedCount {
  delivered: number
  total?: number | null
  status: 'complete' | 'running'
  countStatus: 'exact' | 'lowerBound'
}

/** A layer header's count: "80,412", "1,200 of 80,412", or "1,200 so far". */
export function feedCountText(feed: FeedCount): string {
  const total = feed.total ?? null
  if (feed.status === 'running' || feed.countStatus === 'lowerBound') {
    return `${number.format(Math.max(total ?? 0, feed.delivered))} so far`
  }
  if (total === null) return number.format(feed.delivered)
  return feed.delivered < total ? `${number.format(feed.delivered)} of ${number.format(total)}` : number.format(total)
}

/** "as of 10:42" for an answer read before the data last changed. */
export function asOfText(asOf: string | null | undefined): string | null {
  if (!asOf) return null
  const at = new Date(asOf)
  if (Number.isNaN(at.getTime())) return null
  return `as of ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

/** A layer's count in a sentence: "2 of 80,412 matches", "2 matches so far". */
export function feedCountSentence(feed: FeedCount): string {
  const running = feed.status === 'running' || feed.countStatus === 'lowerBound'
  const shown = running ? Math.max(feed.total ?? 0, feed.delivered) : (feed.total ?? feed.delivered)
  const noun = shown === 1 ? 'match' : 'matches'
  return running ? `${number.format(shown)} ${noun} so far` : `${feedCountText(feed)} ${noun}`
}

/** A capped layer's foot: "Showing 2,000 of 80,412". */
export function cappedText(delivered: number, total?: number | null): string {
  return total && total > delivered
    ? `Showing ${number.format(delivered)} of ${number.format(total)}`
    : `Showing the first ${number.format(delivered)}`
}

// ── A search, in words ─────────────────────────────────────────────────────

const OP_WORDS: Record<string, string> = {
  eq: 'is', neq: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains',
  startsWith: 'starts with', endsWith: 'ends with', in: 'is one of', notIn: 'is not one of',
  isSet: 'is set', isNotSet: 'is not set', between: 'is between',
}

function list(values: unknown[], join = 'or'): string {
  const words = values.map((v) => String(v))
  if (words.length <= 1) return words[0] ?? ''
  if (words.length > 3) return `${words.slice(0, 2).join(', ')} ${join} ${words.length - 2} more`
  return `${words.slice(0, -1).join(', ')} ${join} ${words[words.length - 1]}`
}

/** A search as a short sentence — what a subset view's chip says it shows, and
 *  the name a new one is offered. Covers the conditions people build most;
 *  anything else reads as "a search". */
export function describePredicate(predicate: Predicate | null | undefined,
  typeLabel: (type: string) => string = (t) => t): string {
  const say = (node: Node | undefined, depth: number): string => {
    if (!node || depth > 4) return 'a search'
    switch (node.kind) {
      case 'all': return 'everything'
      case 'text': return `“${String(node.value ?? '')}”`
      case 'tag': {
        const values = (node.values as unknown[]) ?? []
        return `${node.op === 'notIn' ? 'not tagged' : 'tagged'} ${list(values)}`
      }
      case 'entityType': {
        const values = ((node.values as string[]) ?? []).map(typeLabel)
        return node.op === 'notIn' ? `not ${list(values)}` : list(values)
      }
      case 'property': {
        const op = OP_WORDS[String(node.op ?? 'eq')] ?? String(node.op)
        const value = Array.isArray(node.value) ? list(node.value) : node.value
        return value === undefined || value === null ? `${String(node.key)} ${op}` : `${String(node.key)} ${op} ${String(value)}`
      }
      case 'hasProperty': return `with ${String(node.key)}`
      case 'descendantOf': {
        const refs = ((node.refs as Array<{ path?: string[]; urn?: string }>) ?? [])
          .map((r) => (r.path ? r.path[r.path.length - 1] : (r.urn ?? '').split(/[:/]/).pop()))
        const urns = ((node.urns as string[]) ?? []).map((u) => u.split(/[:/]/).pop())
        const names = [...refs, ...urns].filter(Boolean)
        return names.length ? `inside ${list(names)}` : 'inside a container'
      }
      case 'related': {
        const where = node.where as Node | undefined
        return `with ${String(node.axis)} ${where ? say(where, depth + 1) : 'anything'}`
      }
      case 'isOrphan': return 'with no lineage'
      case 'isLeaf': return 'with nothing inside'
      case 'isRoot': return 'at the top'
      case 'group': {
        const children = (node.children as Node[]) ?? []
        if (node.op === 'not') return `not ${say(children[0], depth + 1)}`
        const parts = children.map((c) => say(c, depth + 1))
        return parts.join(node.op === 'or' ? ' or ' : ' and ')
      }
      default: return 'a search'
    }
  }
  return say(predicate as unknown as Node, 0)
}

// ── Words for the header ───────────────────────────────────────────────────

/** The subset chip's text: "Subset of Sales overview". */
export function chipLabel(status: SearchViewStatus): string {
  if (status.definition.within === 'dataSource') return 'Search view'
  if (status.status === 'base_missing') return 'Subset · base view gone'
  return `Subset of ${status.base?.name ?? 'a view you can’t open'}`
}

/** "This also changes 3 subset views" — what a base's editor is told before a
 *  change to its layers, or its deletion. Null when nothing depends on it. */
export function subsetsWarning(count: number, action: 'change' | 'delete' | 'deletePermanently'): string | null {
  if (count <= 0) return null
  const views = `${count.toLocaleString()} subset ${count === 1 ? 'view' : 'views'}`
  const made = `${views} ${count === 1 ? 'is' : 'are'} made from this view.`
  if (action === 'delete') return `${made} Until it’s restored, ${count === 1 ? 'it shows' : 'they show'} nothing.`
  if (action === 'deletePermanently') return `${made} Once it’s gone, ${count === 1 ? 'it shows' : 'they show'} nothing.`
  return `This also changes ${views} made from this view.`
}

/** Whether a board places entities by more than their type — rules on tags,
 *  properties or URNs, groups, anchors, entities placed by hand — which a subset
 *  of it can't follow. Mirrors `search_views.places_by_more_than_type`. */
export function placesByMoreThanType(config: Record<string, unknown>): boolean {
  const layout = (config.layout as { referenceLayout?: Record<string, unknown> } | undefined)?.referenceLayout
    ?? (config.referenceLayout as Record<string, unknown> | undefined) ?? {}
  const assignments = (layout.assignments as Record<string, { layerId?: string }> | undefined) ?? {}
  if (Object.values(assignments).some((e) => e && e.layerId)) return true
  const layers = (layout.layers as Array<Record<string, unknown>> | undefined) ?? []
  return layers.some((layer) => {
    const rules = layer.rules as unknown[] | undefined
    const groups = layer.logicalNodes as unknown[] | undefined
    const legacy = layer.entityAssignments as unknown[] | undefined
    return (rules?.some((r) => r && typeof r === 'object') ?? false) || (groups?.length ?? 0) > 0
      || !!layer.anchorUrn || (legacy?.length ?? 0) > 0
  })
}
