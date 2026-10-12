/**
 * The One Placement Contract — which layer of a view an entity is in, and
 * why. TypeScript twin of backend/app/services/view_placement.py; the
 * shared corpus (backend/tests/fixtures/placement) runs against both.
 *
 * Pure: callers supply each entity's facts and its parents' placements.
 * Tiers, first answer wins:
 *   own explicit entry
 *   > inherited from a hand-placed parent (gated by the DIRECT parent's own
 *     entry, inheritsChildren)
 *   > [a curated view stops here, except an entity created in this draft,
 *     placed by its own stamp — which cascades like a hand placement]
 *   > stamp > own rule (first by priority, then layer order)
 *   > inherited from a stamped or rule-placed parent (gated by the rule's
 *     inheritsFromParent)
 *   > fallback (showUnassigned: drawn there, never a member) > none.
 * A stale entry (naming a layer the view no longer has) falls through and is
 * flagged staleExplicit.
 */
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { ViewContentConfig } from '@/types/schema'
import { deriveEntityScope, normalizeReferenceLayout } from '@/utils/referenceLayout'

import { evaluate, foldCase, resolveRuleComparison, RULE_OPERATORS, SemanticsError, type Comparison } from './semantics'

export interface PlacementFacts {
  urn: string
  entityType: string
  displayName?: string
  tags: readonly string[]
  /** The USER property bag: GraphNode.properties, canvas data.properties. */
  properties: Readonly<Record<string, unknown>>
  /** Legacy layer stamp: top-level layerAssignment, else
   *  properties.layerAssignment — a non-empty string, or absent. */
  stamp?: string
}

export type PlacementSource = 'explicit' | 'inherited' | 'stamped' | 'rule' | 'fallback' | 'none'

/** The agreed output; absent keys are omitted. */
export interface Placement {
  layerId: string | null
  source: PlacementSource
  ruleId?: string
  inheritedFrom?: string
  staleExplicit?: true
  ambiguousParent?: true
}

/** What a placement passes to its children: a hand placement beats a
 *  child's own rule, a soft one only places a child that has none. */
export type Cascade = 'hand' | 'soft'

/** A Placement plus its cascade — internal, never serialized or compared. */
export interface PlacementResult extends Placement {
  cascade: Cascade | null
}

/** A parent's placement as its child sees it (parentContextOf). */
export interface ParentContext {
  urn: string
  layerId: string
  cascade: Cascade
}

export interface CompiledRule {
  id: string
  layerId: string
  /** Folded entity types, any of; null = any type. */
  types: ReadonlySet<string> | null
  /** Exact tags, any of; null = untagged too. */
  tags: ReadonlySet<string> | null
  glob: RegExp | null
  checks: readonly { field: string; cmp: Comparison }[]
  /** inheritsFromParent: children without a placement of their own follow. */
  cascadesSoft: boolean
}

export interface ExplicitEntry {
  layerId: string
  inheritsChildren: boolean
  logicalNodeId?: string
}

export interface CompiledPlacementSpec {
  scope: 'all' | 'curated'
  layerIds: ReadonlySet<string>
  /** First layer by (order, array position). */
  firstLayerId: string | null
  /** First layer by order with showUnassigned: where an unplaced entity is
   *  drawn. */
  fallbackLayerId: string | null
  /** Sorted once: -priority, layer order, layer position, rule index. */
  rules: readonly CompiledRule[]
  /** Entries naming a layer — a stale one names a layer that is gone. */
  explicit: ReadonlyMap<string, ExplicitEntry>
  /** Rules that can never match, and why. They claim nothing. */
  inert: readonly { layerId: string; ruleId: string; reason: string }[]
  /** Some valid entry cascades — only then can an unloaded ancestor matter. */
  hasCascadingExplicit: boolean
  /** The rules that can claim this entity type, in rule order (cached). */
  rulesFor: (entityType: string) => readonly CompiledRule[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * Compile a FULL view config (layout.referenceLayout, else the legacy
 * top-level referenceLayout) once; every placement reads the result.
 */
export function compilePlacementSpec(config: unknown): CompiledPlacementSpec {
  const cfg = isRecord(config) ? config : {}
  const raw = isRecord(cfg.layout) && isRecord(cfg.layout.referenceLayout) ? cfg.layout.referenceLayout
    : isRecord(cfg.referenceLayout) ? cfg.referenceLayout : {}
  const layout = normalizeReferenceLayout(withoutBlankLegacyUrns(raw))
  const scope = deriveEntityScope(cfg.content as ViewContentConfig | undefined, layout)

  const layers = (layout.layers as unknown[])
    .map((layer, position) => ({ layer, position }))
    .filter((l): l is { layer: Record<string, unknown> & { id: string }; position: number } =>
      isRecord(l.layer) && nonEmpty(l.layer.id) !== undefined)
    .sort((a, b) => num(a.layer.order) - num(b.layer.order) || a.position - b.position)
    .map((l) => l.layer)
  const layerIds = new Set(layers.map((l) => l.id))

  const keyed: { rule: CompiledRule; priority: number; rank: number; index: number }[] = []
  const inert: { layerId: string; ruleId: string; reason: string }[] = []
  layers.forEach((layer, rank) => {
    const authored: unknown[] = Array.isArray(layer.rules) ? layer.rules : []
    authored.forEach((rule, index) => {
      if (!isRecord(rule)) return
      const id = nonEmpty(rule.id) ?? `_rule_${layer.id}_${index}`
      const criteria = compileCriteria(rule)
      if (typeof criteria === 'string') {
        inert.push({ layerId: layer.id, ruleId: id, reason: criteria })
        return
      }
      const compiled = { id, layerId: layer.id, ...criteria, cascadesSoft: rule.inheritsFromParent !== false }
      keyed.push({ rule: compiled, priority: num(rule.priority), rank, index })
    })
    // layer.entityTypes: priority-0 rules after the layer's authored ones.
    ;[...new Set(strings(layer.entityTypes))].forEach((t, offset) => keyed.push({
      rule: {
        id: `_type_${layer.id}_${t}`, layerId: layer.id, types: new Set([foldCase(t)]),
        tags: null, glob: null, checks: [], cascadesSoft: true,
      },
      priority: 0, rank, index: authored.length + offset,
    }))
  })
  keyed.sort((a, b) => b.priority - a.priority || a.rank - b.rank || a.index - b.index)
  const rules = keyed.map((k) => k.rule)

  const explicit = new Map<string, ExplicitEntry>()
  for (const [urn, entry] of Object.entries(layout.assignments)) {
    const layerId = nonEmpty(entry.layerId)
    if (layerId === undefined) continue   // '' / missing = absent, never stale
    explicit.set(urn, { layerId, inheritsChildren: entry.inheritsChildren !== false, logicalNodeId: entry.logicalNodeId })
  }

  const byType = new Map<string, readonly CompiledRule[]>()
  return {
    scope,
    layerIds,
    firstLayerId: layers[0]?.id ?? null,
    fallbackLayerId: layers.find((l) => l.showUnassigned === true)?.id ?? null,
    rules,
    explicit,
    inert,
    hasCascadingExplicit: [...explicit.values()].some((e) => e.inheritsChildren && layerIds.has(e.layerId)),
    rulesFor: (entityType) => {
      let candidates = byType.get(entityType)
      if (!candidates) {
        const folded = foldCase(entityType)
        candidates = rules.filter((r) => !r.types || r.types.has(folded))
        byType.set(entityType, candidates)
      }
      return candidates
    },
  }
}

/** parse_reference_layout keys a legacy entityAssignments entry by `urn or
 *  entityId`, the shared normalizer by `urn ?? entityId`. Drop a blank urn
 *  first, so both land on entityId, rather than change the normalizer that
 *  flag-off surfaces still use. */
function withoutBlankLegacyUrns(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.layers)) return raw
  const layers = raw.layers.map((layer: unknown) => (isRecord(layer) && Array.isArray(layer.entityAssignments) ? {
    ...layer,
    entityAssignments: layer.entityAssignments.map((e: unknown) => (isRecord(e) && e.urn === '' ? { ...e, urn: undefined } : e)),
  } : layer))
  return { ...raw, layers }
}

/** A rule = AND of its criteria. Returns why, when it can never match. */
function compileCriteria(rule: Record<string, unknown>): Pick<CompiledRule, 'types' | 'tags' | 'glob' | 'checks'> | string {
  const types = strings(rule.entityTypes).map(foldCase)
  const tags = strings(rule.tags)
  const pattern = nonEmpty(rule.urnPattern)
  const checks: { field: string; cmp: Comparison }[] = []
  for (const c of [rule.propertyMatch, ...(Array.isArray(rule.conditions) ? rule.conditions : [])]) {
    // A blank or non-string field is an unfinished condition: absent, like urnPattern ''.
    if (!isRecord(c) || typeof c.field !== 'string' || c.field === '') continue
    // Python's `operator or 'equals'`: an empty list or object is blank too.
    const blank = !c.operator || (typeof c.operator === 'object' && Object.keys(c.operator).length === 0)
    const operator = blank ? 'equals' : c.operator
    if (typeof operator !== 'string' || !Object.hasOwn(RULE_OPERATORS, operator)) {
      return `uses an unknown operator '${String(operator)}'`
    }
    try {
      checks.push({ field: c.field, cmp: resolveRuleComparison(operator, c.value) })
    } catch (e) {
      if (!(e instanceof SemanticsError)) throw e
      return `cannot compare '${c.field}': ${e.message}`
    }
  }
  if (!types.length && !tags.length && !pattern && !checks.length) {
    return 'has no criteria, so it can never place anything'
  }
  return {
    types: types.length ? new Set(types) : null,
    tags: tags.length ? new Set(tags) : null,
    glob: pattern === undefined ? null : globToRegExp(pattern),
    checks,
  }
}

/** An anchored URN glob: '*' any run (empty and newlines too), '?' exactly
 *  one code point, everything else literal and case-sensitive — so every
 *  string is a valid pattern. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[\\^$.+()[\]{}|]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '[\\s\\S]')
  return new RegExp(`^${source}$`, 'u')
}

/** The first rule, in rule order, that this entity matches. */
export function matchRule(spec: CompiledPlacementSpec, facts: PlacementFacts): CompiledRule | null {
  for (const rule of spec.rulesFor(facts.entityType)) {
    if (rule.tags && !hasAny(rule.tags, facts.tags)) continue
    if (rule.glob && !rule.glob.test(facts.urn)) continue
    if (rule.checks.length > 0 && !passes(rule.checks, facts)) continue
    return rule
  }
  return null
}

function hasAny(wanted: ReadonlySet<string>, tags: readonly string[]): boolean {
  for (const t of tags) if (wanted.has(t)) return true
  return false
}

function passes(checks: CompiledRule['checks'], facts: PlacementFacts): boolean {
  for (const c of checks) if (!evaluate(valueOf(facts, c.field), c.cmp)) return false
  return true
}

/** A user property; when it is null or missing, name / type / urn read the
 *  entity's own display name, type and URN. */
function valueOf(facts: PlacementFacts, field: string): unknown {
  const v = Object.hasOwn(facts.properties, field) ? facts.properties[field] : undefined
  if (v !== null && v !== undefined) return v
  return field === 'name' ? facts.displayName : field === 'type' ? facts.entityType : field === 'urn' ? facts.urn : undefined
}

/**
 * Place one entity. `facts` null = an ancestor known only by its URN: only
 * the explicit tiers can answer. `parents` are its parents' contexts.
 */
export function place(
  spec: CompiledPlacementSpec,
  urn: string,
  facts: PlacementFacts | null,
  parents: readonly ParentContext[],
  createdInBranch = false,
): PlacementResult {
  return resolve(spec, urn, () => facts, parents, createdInBranch)
}

function resolve(
  spec: CompiledPlacementSpec,
  urn: string,
  factsOf: (urn: string) => PlacementFacts | null,
  parents: readonly ParentContext[],
  createdInBranch: boolean,
): PlacementResult {
  const entry = spec.explicit.get(urn)
  if (entry && spec.layerIds.has(entry.layerId)) {
    return { layerId: entry.layerId, source: 'explicit', cascade: entry.inheritsChildren ? 'hand' : null }
  }
  const placed = inherit(spec, parents, 'hand') ?? placeUnpinned(spec, urn, factsOf, parents, createdInBranch)
  if (entry) placed.staleExplicit = true
  return placed
}

function placeUnpinned(
  spec: CompiledPlacementSpec,
  urn: string,
  factsOf: (urn: string) => PlacementFacts | null,
  parents: readonly ParentContext[],
  createdInBranch: boolean,
): PlacementResult {
  // Before facts: a curated view places nothing else, so never builds them.
  if (spec.scope === 'curated' && !createdInBranch) return none()
  const facts = factsOf(urn)
  if (!facts) return none()
  const stamp = facts.stamp && spec.layerIds.has(facts.stamp) ? facts.stamp : null
  if (spec.scope === 'curated') return stamp ? { layerId: stamp, source: 'stamped', cascade: 'hand' } : none()
  if (stamp) return { layerId: stamp, source: 'stamped', cascade: 'soft' }
  const rule = matchRule(spec, facts)
  if (rule) return { layerId: rule.layerId, source: 'rule', ruleId: rule.id, cascade: rule.cascadesSoft ? 'soft' : null }
  return inherit(spec, parents, 'soft')
    ?? (spec.fallbackLayerId ? { layerId: spec.fallbackLayerId, source: 'fallback', cascade: null } : none())
}

/** The smallest-URN parent offering this cascade; ambiguous when the
 *  parents offering it name different layers. */
function inherit(spec: CompiledPlacementSpec, parents: readonly ParentContext[], cascade: Cascade): PlacementResult | null {
  let chosen: ParentContext | null = null
  let ambiguous = false
  for (const p of parents) {
    if (p.cascade !== cascade || !spec.layerIds.has(p.layerId)) continue
    if (chosen && p.layerId !== chosen.layerId) ambiguous = true
    if (!chosen || codePointBefore(p.urn, chosen.urn)) chosen = p
  }
  if (!chosen) return null
  const placed: PlacementResult = { layerId: chosen.layerId, source: 'inherited', inheritedFrom: chosen.urn, cascade }
  if (ambiguous) placed.ambiguousParent = true
  return placed
}

/** Python's str order: by code point, where JS `<` compares UTF-16 units —
 *  they differ only when a surrogate (an astral character) meets
 *  U+E000–U+FFFF, so lift the surrogates above that range. */
function codePointBefore(a: string, b: string): boolean {
  const rank = (unit: number) => (unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit)
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x !== y) return rank(x) < rank(y)
  }
  return a.length < b.length
}

const none = (): PlacementResult => ({ layerId: null, source: 'none', cascade: null })

/** Explicit, inherited, stamped and rule placements are members; a
 *  fallback is display only. */
export function isMember(p: Placement): boolean {
  return p.source !== 'fallback' && p.source !== 'none'
}

/** What a placed parent offers its children, or null when it offers none. */
export function parentContextOf(urn: string, p: PlacementResult): ParentContext | null {
  return p.cascade && p.layerId ? { urn, layerId: p.layerId, cascade: p.cascade } : null
}

/**
 * Place every entity in `urns`, parents first. A parent outside `urns` is
 * unknown. Edges inside a cycle are ignored, so nodes on it resolve through
 * their own tiers while their descendants still inherit, and the result is
 * the same whatever the input order. `factsOf` is called only when the
 * explicit tiers do not answer.
 */
export function placeAll(
  spec: CompiledPlacementSpec,
  urns: Iterable<string>,
  factsOf: (urn: string) => PlacementFacts | null,
  parentsOf: (urn: string) => Iterable<string>,
  createdInBranch?: ReadonlySet<string>,
): Map<string, PlacementResult> {
  const nodes = new Set(urns)
  const parents = new Map<string, readonly string[]>()
  for (const u of nodes) {
    const own: string[] = []
    for (const p of parentsOf(u)) if (p !== u && nodes.has(p) && !own.includes(p)) own.push(p)
    parents.set(u, own)
  }
  let order = parentsFirst(nodes, parents)
  if (!order) {
    const component = components(nodes, parents)
    for (const [u, own] of parents) parents.set(u, own.filter((p) => component.get(p) !== component.get(u)))
    order = parentsFirst(nodes, parents) as string[]
  }
  const placed = new Map<string, PlacementResult>()
  for (const u of order) {
    const contexts: ParentContext[] = []
    for (const p of parents.get(u)!) {
      const context = parentContextOf(p, placed.get(p)!)
      if (context) contexts.push(context)
    }
    placed.set(u, resolve(spec, u, factsOf, contexts, createdInBranch?.has(u) ?? false))
  }
  return placed
}

/** Parents before children (iterative DFS, post-order), or null when the
 *  walk meets a back edge: a cycle. */
function parentsFirst(nodes: Iterable<string>, parents: ReadonlyMap<string, readonly string[]>): string[] | null {
  const DONE = -1
  const next = new Map<string, number>()   // the next parent to visit, DONE once ordered
  const order: string[] = []
  for (const root of nodes) {
    if (next.has(root)) continue
    const stack = [root]
    next.set(root, 0)
    while (stack.length > 0) {
      const u = stack[stack.length - 1]
      const own = parents.get(u)!
      const i = next.get(u)!
      if (i < own.length) {
        next.set(u, i + 1)
        const state = next.get(own[i])
        if (state === undefined) {
          next.set(own[i], 0)
          stack.push(own[i])
        } else if (state !== DONE) {
          return null
        }
      } else {
        next.set(u, DONE)
        order.push(u)
        stack.pop()
      }
    }
  }
  return order
}

/** Tarjan's strongly connected components, iteratively: node -> component. */
function components(nodes: Iterable<string>, parents: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const component = new Map<string, number>()
  const open: string[] = []
  let counter = 0
  const visit = (u: string) => {
    index.set(u, counter)
    low.set(u, counter++)
    open.push(u)
  }
  for (const root of nodes) {
    if (index.has(root)) continue
    visit(root)
    const calls: [string, number][] = [[root, 0]]
    while (calls.length > 0) {
      const frame = calls[calls.length - 1]
      const [u, i] = frame
      const own = parents.get(u)!
      if (i < own.length) {
        frame[1] = i + 1
        const p = own[i]
        if (!index.has(p)) {
          visit(p)
          calls.push([p, 0])
        } else if (!component.has(p)) {
          low.set(u, Math.min(low.get(u)!, index.get(p)!))
        }
        continue
      }
      calls.pop()
      if (calls.length > 0) {
        const caller = calls[calls.length - 1][0]
        low.set(caller, Math.min(low.get(caller)!, low.get(u)!))
      }
      if (low.get(u) === index.get(u)) {
        let w: string
        do {
          w = open.pop()!
          component.set(w, index.get(u)!)
        } while (w !== u)
      }
    }
  }
  return component
}

/**
 * The write-path policy (import roots, Build Mode, rail create): the layer
 * a NEW root entity goes in, and whether to pin it with an explicit entry.
 * A curated view always pins; an open view pins only when the layer differs
 * from what the contract computes anyway.
 */
export function suggestPlacement(
  spec: CompiledPlacementSpec,
  facts: PlacementFacts,
  opts: { chosenLayerId?: string | null; defaultLayerId?: string | null } = {},
): { layerId: string | null; pin: boolean } {
  const valid = (id: string | null | undefined) => (id && spec.layerIds.has(id) ? id : null)
  const curated = spec.scope === 'curated'
  const placed = place(spec, facts.urn, facts, [])
  const member = isMember(placed) ? placed.layerId : null
  let layerId = valid(opts.chosenLayerId) ?? member
  if (layerId === null && curated) {
    const open = place({ ...spec, scope: 'all' }, facts.urn, facts, [])
    layerId = isMember(open) ? open.layerId : null
  }
  layerId = layerId ?? valid(opts.defaultLayerId) ?? (curated ? spec.firstLayerId : null)
  return { layerId, pin: layerId !== null && (curated || layerId !== member) }
}

export function factsFromGraphNode(node: GraphNode): PlacementFacts {
  return toFacts(node.urn, node.entityType, node.displayName, node.tags, node.properties, node.layerAssignment)
}

/** Facts from a canvas node's data (lib/canvasNodeMapper): the user bag is
 *  data.properties, not the data object itself. */
export function factsFromCanvasData(data: Record<string, unknown> | undefined, id: string): PlacementFacts {
  const d = data ?? {}
  return toFacts(nonEmpty(d.urn) ?? id, d.type, d.label, d.classifications, d.properties, d.layerAssignment)
}

function toFacts(
  urn: string, entityType: unknown, displayName: unknown, tags: unknown, properties: unknown, layerAssignment: unknown,
): PlacementFacts {
  const bag = isRecord(properties) ? properties : {}
  const facts: PlacementFacts = {
    urn,
    entityType: typeof entityType === 'string' ? entityType : '',
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
    properties: bag,
  }
  const name = nonEmpty(displayName)
  if (name !== undefined) facts.displayName = name
  // A non-empty top-level stamp hides the bag's, even when it names no layer.
  const stamp = nonEmpty(layerAssignment) ?? nonEmpty(bag.layerAssignment)
  if (stamp !== undefined) facts.stamp = stamp
  return facts
}
