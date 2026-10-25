/**
 * The search harness's server: the search endpoints the panel calls,
 * answered from the in-memory catalog in `searchFixtures` by a small
 * predicate evaluator. Not the engine — just faithful enough that counts,
 * results, names and empty answers agree with each other on screen, so a
 * screenshot shows the panel as a person would see it.
 */
import type {
    EdgePredicateNode,
    EdgePropertyPredicate,
    NodeRef,
    Predicate,
    RelatedPredicate,
    SearchQuery,
} from '@/types/search'

import { HARNESS_EDGES, HARNESS_ENTITIES, type HarnessEdge, type HarnessEntity } from './searchFixtures'


const BY_URN = new Map(HARNESS_ENTITIES.map((e) => [e.urn, e]))
const CHILDREN = new Map<string, HarnessEntity[]>()
for (const e of HARNESS_ENTITIES) {
    if (!e.parent) continue
    CHILDREN.set(e.parent, [...(CHILDREN.get(e.parent) ?? []), e])
}
const OUT = new Map<string, HarnessEdge[]>()
const IN = new Map<string, HarnessEdge[]>()
for (const edge of HARNESS_EDGES) {
    OUT.set(edge.source, [...(OUT.get(edge.source) ?? []), edge])
    IN.set(edge.target, [...(IN.get(edge.target) ?? []), edge])
}

/** The lineage types; containment is the tree (``parent``), not an edge. */
const LINEAGE = new Set(['TRANSFORMS', 'PRODUCES', 'CONSUMES'])

interface EdgeSet { edgeClass?: string | null; edgeTypes?: string[] | null }

/** Whether ``edge`` is one of the edges a condition counts or walks. */
function edgeIn(edge: HarnessEdge, p: EdgeSet): boolean {
    if (p.edgeTypes) return p.edgeTypes.some((t) => t.toUpperCase() === edge.type.toUpperCase())
    if (p.edgeClass === 'links' || p.edgeClass === 'any') return true
    return p.edgeClass !== 'containment' && LINEAGE.has(edge.type)
}

/** How many of a condition's edges an entity has, in, out or both. */
function edgeCount(e: HarnessEntity, p: EdgeSet, direction: 'in' | 'out' | 'both'): number {
    const tree = !p.edgeTypes && (p.edgeClass === 'containment' || p.edgeClass === 'any')
    const inn = (IN.get(e.urn) ?? []).filter((x) => edgeIn(x, p)).length + (tree && e.parent ? 1 : 0)
    const out = (OUT.get(e.urn) ?? []).filter((x) => edgeIn(x, p)).length
        + (tree ? CHILDREN.get(e.urn)?.length ?? 0 : 0)
    return direction === 'in' ? inn : direction === 'out' ? out : inn + out
}

/** Root first, the entity's parent last. */
function ancestors(e: HarnessEntity): HarnessEntity[] {
    const out: HarnessEntity[] = []
    let p = e.parent ? BY_URN.get(e.parent) : undefined
    while (p) {
        out.unshift(p)
        p = p.parent ? BY_URN.get(p.parent) : undefined
    }
    return out
}

function descendants(e: HarnessEntity): HarnessEntity[] {
    const out: HarnessEntity[] = []
    const walk = (x: HarnessEntity) => {
        for (const c of CHILDREN.get(x.urn) ?? []) { out.push(c); walk(c) }
    }
    walk(e)
    return out
}


// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function nameMatches(chain: string[], path: string[]): boolean {
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    if (path[0] === '**') {
        const tail = path.slice(1)
        if (tail.length > chain.length) return false
        const start = chain.length - tail.length
        return tail.every((seg, i) => eq(seg, chain[start + i]))
    }
    return path.length === chain.length && path.every((seg, i) => eq(seg, chain[i]))
}

export function resolveRef(ref: NodeRef): HarnessEntity[] {
    if (ref.urn) return BY_URN.has(ref.urn) ? [BY_URN.get(ref.urn)!] : []
    const path = ref.path ?? []
    return HARNESS_ENTITIES.filter((e) =>
        (!ref.entityType || e.entityType === ref.entityType)
        && nameMatches([...ancestors(e).map((a) => a.displayName), e.displayName], path))
}

function resolveAll(urns?: string[] | null, refs?: NodeRef[] | null): Set<string> {
    const out = new Set<string>()
    for (const u of urns ?? []) out.add(u)
    for (const r of refs ?? []) for (const e of resolveRef(r)) out.add(e.urn)
    return out
}


// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function textOf(e: HarnessEntity, target: string): string[] {
    switch (target) {
        case 'name': return [e.displayName]
        case 'qualifiedName': return [qualifiedName(e)]
        case 'description': return [e.description ?? '']
        case 'tags': return e.tags
        default: return [e.displayName, qualifiedName(e), e.description ?? '', ...e.tags]
    }
}

function qualifiedName(e: HarnessEntity): string {
    return [...ancestors(e).map((a) => a.displayName), e.displayName].join('.')
}

function propertyOf(e: HarnessEntity, key: string): unknown {
    if (key === 'description') return e.description
    if (key === 'layerAssignment') return e.layerAssignment
    return e.properties[key]
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
    const set = actual !== undefined && actual !== null && actual !== ''
    if (op === 'isSet' || op === 'isNotEmpty') return set
    if (op === 'isNotSet' || op === 'isEmpty') return !set
    if (!set) return false
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
    const text = (v: unknown) => String(v).toLowerCase()
    switch (op) {
        case 'eq': return typeof actual === 'number' ? actual === num(expected) : text(actual) === text(expected)
        case 'neq': return typeof actual === 'number' ? actual !== num(expected) : text(actual) !== text(expected)
        case 'gt': return num(actual) > num(expected)
        case 'gte': return num(actual) >= num(expected)
        case 'lt': return num(actual) < num(expected)
        case 'lte': return num(actual) <= num(expected)
        case 'between': {
            const [lo, hi] = (expected as unknown[]) ?? []
            return num(actual) >= num(lo) && num(actual) <= num(hi)
        }
        case 'in': return ((expected as unknown[]) ?? []).some((v) => text(v) === text(actual))
        case 'notIn': return !((expected as unknown[]) ?? []).some((v) => text(v) === text(actual))
        case 'contains': return text(actual).includes(text(expected))
        case 'notContains': return !text(actual).includes(text(expected))
        case 'startsWith': return text(actual).startsWith(text(expected))
        case 'endsWith': return text(actual).endsWith(text(expected))
        default: return false
    }
}

function edgeMatches(edge: HarnessEdge, p: EdgePredicateNode | null | undefined): boolean {
    if (!p) return true
    if (p.kind === 'edgeGroup') {
        if (p.op === 'not') return !edgeMatches(edge, p.children[0])
        return p.op === 'or' ? p.children.some((c) => edgeMatches(edge, c)) : p.children.every((c) => edgeMatches(edge, c))
    }
    if (p.kind === 'edgeHasProperty') return (p.key in edge.properties) !== !!p.negate
    const prop = p as EdgePropertyPredicate
    return compare(edge.properties[prop.key], prop.op ?? 'eq', prop.value)
}

/** The relatives along ``axis`` within its hop range. */
function relatives(e: HarnessEntity, p: RelatedPredicate): HarnessEntity[] {
    const lo = p.minHops ?? 1
    switch (p.axis) {
        case 'parent': return e.parent ? [BY_URN.get(e.parent)!] : []
        case 'root': { const a = ancestors(e); return a.length ? [a[0]] : [] }
        case 'ancestor': {
            const a = ancestors(e).reverse()                 // nearest first
            return a.slice(lo - 1, p.maxHops ?? a.length)
        }
        case 'child': return CHILDREN.get(e.urn) ?? []
        case 'descendant': return descendants(e)
        default: {
            const hi = p.maxHops ?? lo
            const walked = (x: HarnessEdge) => edgeIn(x, { edgeClass: p.edgeClass ?? 'lineage', edgeTypes: p.edgeTypes })
                && edgeMatches(x, p.edge)
            const step = (urn: string): string[] => {
                const out = p.axis === 'upstream' ? [] : (OUT.get(urn) ?? []).filter(walked).map((x) => x.target)
                const inn = p.axis === 'downstream' ? [] : (IN.get(urn) ?? []).filter(walked).map((x) => x.source)
                return [...out, ...inn]
            }
            const found = new Set<string>()
            let frontier = [e.urn]
            for (let hop = 1; hop <= hi; hop++) {
                frontier = frontier.flatMap(step)
                if (hop >= lo) frontier.forEach((u) => found.add(u))
            }
            found.delete(e.urn)
            return [...found].map((u) => BY_URN.get(u)!).filter(Boolean)
        }
    }
}

function countOk(n: number, op: string, value: number): boolean {
    return compare(n, op, value)
}

export function matches(e: HarnessEntity, p: Predicate): boolean {
    switch (p.kind) {
        case 'group': {
            const op = p.op ?? 'and'
            if (op === 'not') return !p.children.every((c) => matches(e, c))
            return op === 'or' ? p.children.some((c) => matches(e, c)) : p.children.every((c) => matches(e, c))
        }
        case 'all': return true
        case 'text': {
            const needle = p.caseSensitive ? p.value : p.value.toLowerCase()
            return textOf(e, p.target ?? 'name').some((raw) => {
                const hay = p.caseSensitive ? raw : raw.toLowerCase()
                switch (p.match ?? 'substring') {
                    case 'exact': return hay === needle
                    case 'prefix': return hay.startsWith(needle)
                    case 'suffix': return hay.endsWith(needle)
                    default: return hay.includes(needle)
                }
            })
        }
        case 'entityType': {
            const hit = p.values.includes(e.entityType)
            return p.op === 'notIn' ? !hit : hit
        }
        case 'tag': {
            const has = (t: string) => e.tags.some((x) => x.toLowerCase() === t.toLowerCase())
            switch (p.op ?? 'hasAny') {
                case 'hasAll': return p.values.every(has)
                case 'notHas': return !p.values.some(has)
                default: return p.values.some(has)
            }
        }
        case 'layer': return e.layerAssignment === p.layerAssignment
        case 'hasProperty': {
            const keys = [...Object.keys(e.properties), ...(e.description ? ['description'] : [])]
            const k = p.key.toLowerCase()
            const hit = keys.some((key) => (p.keyMatch === 'prefix' ? key.toLowerCase().startsWith(k)
                : p.keyMatch === 'contains' ? key.toLowerCase().includes(k) : key.toLowerCase() === k))
            return p.negate ? !hit : hit
        }
        case 'property': {
            const actual = propertyOf(e, p.key)
            if (p.valueKey != null) {
                // Another property of the same entity: both must be set.
                const other = propertyOf(e, p.valueKey)
                return actual != null && other != null && compare(actual, p.op ?? 'eq', other)
            }
            const ok = compare(actual, p.op ?? 'eq', p.value)
            return ok || (!!p.includeMissing && (actual === undefined || actual === null))
        }
        case 'descendantOf': {
            const anchors = resolveAll(p.urns, p.refs)
            return ancestors(e).some((a) => anchors.has(a.urn))
        }
        case 'is': return resolveAll([], p.refs).has(e.urn)
        case 'related': {
            const rel = relatives(e, p)
            const good = p.where ? rel.filter((r) => matches(r, p.where!)) : rel
            if (p.count) return countOk(good.length, p.count.op ?? 'gte', p.count.value)
            switch (p.quantifier ?? 'any') {
                case 'none': return good.length === 0
                case 'all': return rel.length > 0 && good.length === rel.length
                default: return good.length > 0
            }
        }
        case 'isRoot': return edgeCount(e, p, 'in') === 0
        case 'isLeaf': return edgeCount(e, p, 'out') === 0
        case 'isOrphan': return edgeCount(e, p, 'both') === 0
        case 'hasIncoming': return edgeCount(e, p, 'in') > 0
        case 'hasOutgoing': return edgeCount(e, p, 'out') > 0
        case 'withinHops': {
            const anchors = resolveAll(p.urns, p.refs)
            const axis = p.direction === 'in' ? 'downstream' : p.direction === 'out' ? 'upstream' : 'neighbor'
            return relatives(e, { kind: 'related', axis, maxHops: p.hops } as RelatedPredicate)
                .some((r) => anchors.has(r.urn))
        }
        case 'degree':
            return countOk(edgeCount(e, p, p.direction ?? 'both'), p.op ?? 'gte', p.value)
        default: return false
    }
}


// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Every entity in scope: the view holds the whole catalog. */
function inScope(): HarnessEntity[] {
    return [...HARNESS_ENTITIES]
}

function node(e: HarnessEntity) {
    return {
        urn: e.urn, displayName: e.displayName, entityType: e.entityType, tags: e.tags,
        description: e.description, layerAssignment: e.layerAssignment, qualifiedName: qualifiedName(e),
        properties: e.properties, childCount: CHILDREN.get(e.urn)?.length ?? 0,
    }
}

const ref = (a: HarnessEntity) => ({ urn: a.urn, displayName: a.displayName, entityType: a.entityType })

const sessions = new Map<string, Predicate>()

function advanced(query: SearchQuery) {
    const p = query.predicate
    if (p?.kind === 'path') {
        return { status: 'complete', elapsedMs: 4, paths: [], totalCount: 0, countStatus: 'exact' }
    }
    const all = inScope().filter((e) => (p ? matches(e, p) : true))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    const offset = Number(query.options?.cursor ?? 0) || 0
    const size = query.options?.pageSize ?? 50
    const page = all.slice(offset, offset + size)
    const sessionId = `harness-${sessions.size + 1}`
    if (p) sessions.set(sessionId, p)
    // The ancestor facet the canvas badges read: every container, with how
    // many matches sit below it.
    const buckets = new Map<string, { a: HarnessEntity; n: number }>()
    for (const e of all) {
        for (const a of ancestors(e)) {
            const b = buckets.get(a.urn) ?? { a, n: 0 }
            b.n += 1
            buckets.set(a.urn, b)
        }
    }
    return {
        status: 'complete', elapsedMs: 6, sessionId, totalCount: all.length, candidateCount: all.length,
        countStatus: 'exact', cursor: offset + size < all.length ? String(offset + size) : null,
        hits: page.map((e) => ({ node: node(e), ancestorPath: ancestors(e).map(ref), highlights: [] })),
        aggregates: [[...buckets.values()].map(({ a, n }) => ({
            ancestorUrn: a.urn, ancestorDisplayName: a.displayName, ancestorEntityType: a.entityType,
            ancestorDepthFromScopeRoot: ancestors(a).length, matchCount: n,
            sampleHits: [], subBuckets: [], typeCounts: {},
        }))],
    }
}

/** Whether ``p`` holds a route search anywhere — the one kind with no count. */
function hasRoute(p: Predicate): boolean {
    if (p.kind === 'path') return true
    if (p.kind === 'group') return p.children.some(hasRoute)
    return p.kind === 'related' && !!p.where && hasRoute(p.where)
}

function counts(body: { items: Array<{ id: string; predicate: Predicate }> }) {
    const scope = inScope()
    return {
        counts: Object.fromEntries(body.items.map((item) => {
            if (hasRoute(item.predicate)) {
                return [item.id, { count: 0, status: 'complete', error: 'A path search has no count.' }]
            }
            return [item.id, { count: scope.filter((e) => matches(e, item.predicate)).length, status: 'complete' }]
        })),
    }
}

function discover() {
    const labels: Record<string, { sampled: number; keys: string[]; valueSamplesByKey: Record<string, unknown[]> }> = {}
    const tagValues: Record<string, number> = {}
    for (const e of HARNESS_ENTITIES) {
        const l = labels[e.entityType] ??= { sampled: 0, keys: [], valueSamplesByKey: {} }
        l.sampled += 1
        const props = { ...e.properties, ...(e.layerAssignment ? { layerAssignment: e.layerAssignment } : {}) }
        for (const [k, v] of Object.entries(props)) {
            if (!l.keys.includes(k)) l.keys.push(k)
            const samples = l.valueSamplesByKey[k] ??= []
            if (samples.length < 20 && !samples.includes(v)) samples.push(v)
        }
        for (const t of e.tags) tagValues[t] = (tagValues[t] ?? 0) + 1
    }
    for (const l of Object.values(labels)) l.keys.sort()
    const edges: Record<string, { sampled: number; keys: string[]; valueSamplesByKey: Record<string, unknown[]>;
        storedAs: Record<string, string> }> = {}
    for (const edge of HARNESS_EDGES) {
        (edges[edge.type] ??= { sampled: 0, keys: [], valueSamplesByKey: {}, storedAs: {} }).sampled += 1
    }
    edges.TRANSFORMS = { ...edges.TRANSFORMS, keys: ['logic', 'mode'],
        valueSamplesByKey: { logic: ['Direct Query', 'Extract'], mode: ['batch', 'stream'] },
        storedAs: { logic: 'native', mode: 'json' } }
    return { labels, tagValues, elapsedMs: 3, edges }
}

function values(key: string, q: string, limit: number) {
    const counted = new Map<string, { value: unknown; count: number }>()
    for (const e of HARNESS_ENTITIES) {
        const v = propertyOf(e, key)
        if (v === undefined || v === null) continue
        if (q && !String(v).toLowerCase().includes(q.toLowerCase())) continue
        const c = counted.get(String(v)) ?? { value: v, count: 0 }
        c.count += 1
        counted.set(String(v), c)
    }
    return {
        key, complete: true, truncated: false, elapsedMs: 2,
        values: [...counted.values()].sort((a, b) => b.count - a.count).slice(0, limit),
    }
}

function resolve(body: { refs: NodeRef[] }) {
    return {
        elapsedMs: 2,
        results: body.refs.map((r) => {
            const found = resolveRef(r)
            return { count: found.length, matches: found.slice(0, 10).map((e) => ({
                ...ref(e), ancestorPath: ancestors(e).map(ref) })) }
        }),
    }
}

interface PropertyStat {
    count: number
    byEntityType: Record<string, number>
    values: Map<string, { value: unknown; count: number }>
}

function catalog() {
    const types = new Map<string, number>()
    const tags = new Map<string, number>()
    const props = new Map<string, PropertyStat>()
    for (const e of HARNESS_ENTITIES) {
        types.set(e.entityType, (types.get(e.entityType) ?? 0) + 1)
        for (const t of e.tags) tags.set(t, (tags.get(t) ?? 0) + 1)
        for (const [k, v] of Object.entries(e.properties)) {
            const p: PropertyStat = props.get(k) ?? { count: 0, byEntityType: {}, values: new Map() }
            p.count += 1
            p.byEntityType[e.entityType] = (p.byEntityType[e.entityType] ?? 0) + 1
            const c = p.values.get(String(v)) ?? { value: v, count: 0 }
            c.count += 1
            p.values.set(String(v), c)
            props.set(k, p)
        }
    }
    return {
        sessionId: 'harness-catalog', status: 'complete', entities: HARNESS_ENTITIES.length,
        tagged: HARNESS_ENTITIES.filter((e) => e.tags.length).length,
        entityTypes: [...types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
        properties: [...props].map(([key, p]) => ({
            key, count: p.count, byEntityType: p.byEntityType, distinct: p.values.size, distinctExact: true,
            kinds: { [typeof [...p.values.values()][0]?.value === 'number' ? 'number' : 'string']: p.count },
            values: [...p.values.values()].sort((a, b) => b.count - a.count).slice(0, 20)
                .map((v) => ({ value: v.value, kind: typeof v.value === 'number' ? 'number' : 'string', count: v.count })),
        })).sort((a, b) => b.count - a.count),
    }
}

function ancestorCounts(body: { sessionId?: string; urns?: string[] }) {
    const p = body.sessionId ? sessions.get(body.sessionId) : undefined
    const hits = p ? inScope().filter((e) => matches(e, p)) : []
    return {
        status: 'complete',
        counts: Object.fromEntries((body.urns ?? []).map((urn) => [urn, {
            count: hits.filter((h) => ancestors(h).some((a) => a.urn === urn)).length,
        }])),
    }
}

function explain(query: SearchQuery) {
    const cypher = `MATCH (n)\nWHERE /* ${JSON.stringify(query.predicate)} */ true\nRETURN n.urn LIMIT 50000`
    return { cypher, hits_cypher: cypher, candidate_cap: 50000, params: {}, notes: [], inlinedCypher: cypher }
}


export interface FakeFetchOptions {
    method?: string
    body?: string
    signal?: AbortSignal
    extraParams?: Record<string, string>
}

/** One request, answered as the server would — after ``latencyMs``. */
export async function searchFetch(path: string, opts: FakeFetchOptions = {}, latencyMs = 0): Promise<unknown> {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs))
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const body = opts.body ? JSON.parse(opts.body) : {}
    const params = opts.extraParams ?? {}
    switch (path) {
        case '/search/advanced': return advanced(body as SearchQuery)
        case '/search/counts': return counts(body)
        case '/search/discover': return discover()
        case '/search/values': return values(params.key ?? '', params.q ?? '', Number(params.limit ?? 25))
        case '/search/resolve': return resolve(body)
        case '/search/catalog': return catalog()
        case '/search/ancestor-counts': return ancestorCounts(body)
        case '/search/explain': return explain(body as SearchQuery)
        default:
            console.warn('[search harness] no answer for', path)
            return {}
    }
}
