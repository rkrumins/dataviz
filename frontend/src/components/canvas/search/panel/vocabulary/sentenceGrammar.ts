/**
 * sentenceGrammar — the words a condition is read in, as segments rather
 * than markup: plain text, the values a person picked, gaps still to fill,
 * emphasis, and a relationship's own condition. Two surfaces read them —
 * the read-only sentence (`predicateSentence`) prints them; the Sentence
 * builder turns every segment tagged with a `slot` into a token that opens
 * the editor for that part of the condition. One grammar, so the two can
 * never word the same condition differently.
 */
import { formatUrnLabel } from '@/lib/urnLabels'
import type {
    EdgePredicateNode,
    EdgePropertyPredicate,
    NodeRef,
    Predicate,
    PropertyPredicate,
    RelatedPredicate,
} from '@/types/search'

import { arityOf, isNegative, operatorLabel, predicateType } from '../../typed/operators'
import { describeDuration } from '../../typed/valueCodec'
import { axisMeta, hopRange, refLabel } from '../relations'


/** The part of a condition a segment sets — what its token edits. */
export type Slot =
    | 'phrase' | 'text' | 'types' | 'tags' | 'layer' | 'key' | 'value'
    | 'refs' | 'relation' | 'count' | 'hops' | 'edge' | 'source' | 'target'

export type Emphasis = 'not' | 'every'

export type Segment =
    /** Words. With a `slot`, the words ARE the choice ("has no upstream
     *  lineage") — the builder makes them a token; the sentence prints them. */
    | { t: 'text'; text: string; slot?: Slot }
    /** Something picked: a name, a type, a number. */
    | { t: 'value'; text: string; quoted: boolean; slot?: Slot }
    /** A value not picked yet. */
    | { t: 'gap'; slot?: Slot }
    | { t: 'em'; text: string; tone: Emphasis }
    /** A qualifier read quieter: "(match case)". */
    | { t: 'note'; text: string }
    /** A condition on a relative or a route's end. `lead`: whether its
     *  connecting word ("that" / "where") comes first. */
    | { t: 'cond'; predicate: Predicate; many: boolean; lead: 'connector' | 'none' }


const txt = (text: string, slot?: Slot): Segment => (slot ? { t: 'text', text, slot } : { t: 'text', text })
const val = (text: string, quoted: boolean, slot?: Slot): Segment =>
    (slot ? { t: 'value', text, quoted, slot } : { t: 'value', text, quoted })

/** ``segs`` for each item, ``sep`` between them. */
function joined<T>(items: readonly T[], sep: string, segs: (item: T) => Segment[]): Segment[] {
    return items.flatMap((item, i) => (i > 0 ? [txt(sep), ...segs(item)] : segs(item)))
}


// ---------------------------------------------------------------------------
// Agreement and connectors
// ---------------------------------------------------------------------------

const ONE = { has: 'has', is: 'is', does: 'does', lies: 'lies' }
const MANY = { has: 'have', is: 'are', does: 'do', lies: 'lie' }

/** Clauses that begin with a verb — "has a parent", "is inside Finance",
 *  "is tagged …" — follow "that"; the rest name an attribute ("type is
 *  dataset") and follow "where". */
const VERB_CLAUSES = new Set<string>([
    'tag', 'hasProperty', 'isRoot', 'isLeaf', 'isOrphan', 'hasIncoming', 'hasOutgoing',
    'descendantOf', 'withinHops', 'path', 'is', 'related', 'degree',
])

/** The word joining a condition to what it describes. A group of verb
 *  clauses reads "that (is inside X AND has a source)" — unless it
 *  describes several, whose verbs it can't make agree. */
export function connector(p: Predicate, many = false): 'that' | 'where' {
    if (p.kind === 'group') {
        const verbs = (p.op ?? 'and') !== 'not' && p.children.length > 0
            && p.children.every((c) => connector(c) === 'that')
        return verbs && (!many || p.children.length === 1) ? 'that' : 'where'
    }
    return p.kind && VERB_CLAUSES.has(p.kind) ? 'that' : 'where'
}


// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/** The entities an end names: its URNs' labels, then its names. */
export function named(urns?: string[] | null, refs?: NodeRef[] | null): string[] {
    return [...(urns ?? []).map((u) => formatUrnLabel(u)), ...(refs ?? []).map(refLabel)]
}

const TEXT_FIELD: Record<string, string> = {
    name: 'name', qualifiedName: 'qualified name', description: 'description', tags: 'tags',
    any: 'any text field',
}
const TEXT_VERB: Record<string, string> = {
    exact: 'is exactly', prefix: 'starts with', suffix: 'ends with',
}

/**
 * One condition as a phrase fragment, for the caller to set in its own
 * sentence ("Anything where **name contains "t2"**"). ``many``: it
 * describes several entities, so its verb agrees ("have a parent").
 */
export function leafSegments(p: Predicate, many = false): Segment[] {
    const v = many ? MANY : ONE
    switch (p.kind) {
        case 'text': {
            const target = p.target ?? 'name'
            const field = TEXT_FIELD[target] ?? target
            const verb = TEXT_VERB[p.match ?? 'substring'] ?? 'contains'
            return [txt(`${field} ${verb}`, 'phrase'), txt(' '), val(p.value, true, 'text')]
        }
        case 'entityType': {
            const verb = p.op === 'notIn' ? 'is not' : 'is'
            return p.values.length === 1
                ? [txt(`type ${verb}`, 'phrase'), txt(' '), val(p.values[0], true, 'types')]
                : [txt(`type ${verb} one of`, 'phrase'), txt(' '),
                    ...joined(p.values, ' / ', (t) => [val(t, true, 'types')])]
        }
        case 'tag': {
            const op = p.op ?? 'hasAny'
            const verb = op === 'hasAll' ? `${v.is} tagged with all of`
                : op === 'notHas' ? `${v.is} NOT tagged with`
                    : `${v.is} tagged`
            return [txt(verb, 'phrase'), txt(' '), ...joined(p.values, ', ', (t) => [val(`#${t}`, false, 'tags')])]
        }
        case 'layer':
            return [txt('layer is', 'phrase'), txt(' '),
                val(p.layerAssignment, typeof p.layerAssignment === 'string', 'layer')]
        case 'hasProperty': {
            const has = p.negate ? `${v.does} not have` : v.has
            if (p.keyMatch === 'prefix' || p.keyMatch === 'contains') {
                const how = p.keyMatch === 'prefix' ? 'starts with' : 'contains'
                return [txt(`${has} a property whose name ${how}`, 'phrase'), txt(' '), val(p.key, true, 'key')]
            }
            return [txt(`${has} a`, 'phrase'), txt(' '), val(p.key, true, 'key'), txt(' property')]
        }
        case 'property':
            return propertySegments(p)
        case 'isRoot':      return [txt(`${v.has} no upstream lineage`, 'phrase')]
        case 'isLeaf':      return [txt(`${v.has} no downstream lineage`, 'phrase')]
        case 'isOrphan':    return [txt(`${v.has} no lineage edges`, 'phrase')]
        case 'hasIncoming': return [txt(`${v.has} upstream lineage`, 'phrase')]
        case 'hasOutgoing': return [txt(`${v.has} downstream lineage`, 'phrase')]
        case 'descendantOf': {
            const anchors = named(p.urns, p.refs)
            return anchors.length === 1
                ? [txt(`${v.is} inside`, 'phrase'), txt(' '), val(anchors[0], true, 'refs')]
                : [txt(`${v.is} inside`, 'phrase'), txt(' '), val(String(anchors.length), false, 'refs'),
                    txt(' subtrees')]
        }
        case 'withinHops': {
            const dir = p.direction === 'in' ? 'upstream of'
                : p.direction === 'out' ? 'downstream of' : 'within'
            return [txt(`${v.is} ≤ ${p.hops} hop${p.hops === 1 ? '' : 's'} ${dir}`, 'phrase'), txt(' '),
                val(named(p.urns, p.refs)[0] ?? '…', true, 'refs')]
        }
        case 'path': {
            const end = (slot: Slot, urns?: string[] | null, refs?: NodeRef[] | null,
                where?: Predicate | null): Segment[] => {
                if (where) return [txt('anything '), { t: 'cond', predicate: where, many: false, lead: 'connector' }]
                const names = named(urns, refs)
                return names.length > 1
                    ? [txt('any of '), ...joined(names, ', ', (n) => [val(n, true, slot)])]
                    : [val(names[0] ?? '…', true, slot)]
            }
            return [txt(`${v.lies} on a route from`, 'phrase'), txt(' '),
                ...end('source', p.sourceUrns, p.sourceRefs, p.sourceWhere), txt(' to '),
                ...end('target', p.targetUrns, p.targetRefs, p.targetWhere),
                txt(' '), txt(`(up to ${p.maxHops ?? 4} hops)`, 'hops')]
        }
        case 'is': {
            const names = named([], p.refs)
            return names.length === 1
                ? [txt(v.is, 'phrase'), txt(' '), val(names[0], true, 'refs')]
                : [txt(`${v.is} one of`, 'phrase'), txt(' '), ...joined(names, ', ', (n) => [val(n, true, 'refs')])]
        }
        case 'related':
            return relationSegments(p, many)
        case 'degree':
            return [txt(`${v.has} ${p.direction ?? 'any'} edges ${p.op} ${p.value}`, 'phrase')]
        case 'all':
            return [txt('every entity is included', 'phrase')]
        case 'group':
            return [txt('(nested group)')]
        default:
            return [txt('(unknown filter)')]
    }
}


/** Compared as these, a value reads bare — unless the operator reads its
 *  text ("contains 74" means the digits). */
const BARE_TYPES = new Set(['number', 'boolean'])
const TEXT_OPS = new Set(['contains', 'notContains', 'startsWith', 'endsWith'])

function propertySegments(p: PropertyPredicate): Segment[] {
    const op = p.op ?? 'eq'
    const arity = arityOf(op)
    const type = predicateType(p)
    const out: Segment[] = [val(p.key, true, 'key'), txt(' '), txt(operatorLabel(op, type), 'phrase')]
    if (arity === 'duration') {
        out.push(txt(' '), val(describeDuration(p.value) ?? '…', false, 'value'))
    } else if (arity !== 'none') {
        out.push(txt(' '), ...valueSegments(p.value, op === 'between',
            BARE_TYPES.has(type) && !TEXT_OPS.has(op), 'value'))
    }
    if (p.caseSensitive && arity !== 'none') out.push({ t: 'note', text: ' (match case)' })
    if (p.includeMissing && isNegative(op)) out.push({ t: 'note', text: ' (or not set)' })
    return out
}


/** A property value as the query will compare it: text quoted, numbers and
 *  booleans bare, a list as its items, a range as both ends, and an empty
 *  value as a gap waiting to be filled — never as `""`, which read as "equals
 *  the empty string". ``bare``: a number or true/false, bare even when it
 *  travels as text (a 64-bit integer does, to keep its digits). */
function valueSegments(value: unknown, between: boolean, bare: boolean, slot: Slot): Segment[] {
    const one = (v: unknown): Segment[] => {
        if (v === null || v === undefined || v === '') return [{ t: 'gap', slot }]
        if (typeof v === 'string') return [val(v, !bare, slot)]
        return [val(typeof v === 'object' ? JSON.stringify(v) : String(v), false, slot)]
    }
    if (!Array.isArray(value)) return one(value)
    if (between) return [...one(value[0]), txt(' and '), ...one(value[1])]
    if (value.length === 0) return one(undefined)
    return joined(value, ', ', one)
}


// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** The names in "is X or inside X" — what a lineage question about a
 *  container asks of a relative — or null for any other condition. */
export function isOrInside(p: Predicate): NodeRef[] | null {
    if (p.kind !== 'group' || p.op !== 'or' || p.children.length !== 2) return null
    const is = p.children.find((c) => c.kind === 'is')
    const inside = p.children.find((c) => c.kind === 'related')
    if (is?.kind !== 'is' || inside?.kind !== 'related' || inside.axis !== 'ancestor'
        || inside.count || (inside.quantifier ?? 'any') !== 'any'
        || inside.minHops || inside.maxHops || inside.where?.kind !== 'is') return null
    return JSON.stringify(inside.where.refs) === JSON.stringify(is.refs) ? is.refs : null
}

/** "is or is inside VBAP" — "are or are inside …" when it describes several. */
export function isOrInsideSegments(refs: NodeRef[], many = false): Segment[] {
    const v = many ? MANY : ONE
    const names = named([], refs)
    return names.length === 1
        ? [txt(`${v.is} or ${v.is} inside`, 'phrase'), txt(' '), val(names[0], true, 'refs')]
        : [txt(`${v.is} or ${v.is} inside`, 'phrase'), txt(' one of '),
            ...joined(names, ', ', (n) => [val(n, true, 'refs')])]
}

const COUNT_WORDS: Record<string, string> = {
    eq: 'exactly', neq: 'other than', gt: 'more than', gte: 'at least', lt: 'fewer than',
    lte: 'at most',
}

/** How far a relationship looks, as read after its relative: "within 1–3
 *  hops" along lineage, "2–4 levels away" up or down the tree — nothing
 *  when it is one step. */
export function reachSegments(p: RelatedPredicate): Segment[] {
    const meta = axisMeta(p.axis)
    const [lo, hi] = hopRange(p)
    const span = lo === hi ? `${hi}` : `${lo}–${hi}`
    if (meta.lineage) return hi > 1 ? [txt(' '), txt(`within ${span} hops`, 'hops')] : []
    return meta.hops && (p.minHops || p.maxHops) ? [txt(' '), txt(`${span} levels away`, 'hops')] : []
}

/** The edges a relationship walks: "through edges where mode is stream". */
export function viaSegments(p: RelatedPredicate): Segment[] {
    if (!p.edge) return []
    // After a condition, a comma keeps the edges from reading as part of it.
    return [txt(`${p.where ? ',' : ''} through edges where `), ...edgeSegments(p.edge)]
}

/** "has a parent where type is domain", "has a parent that is Finance",
 *  "has no source within 3 hops", "has children, every one where …",
 *  "has more than 100 children that have …" — the relative named for
 *  what it is, never in or out. The edges walked come last: "has a target
 *  that is X, through edges where …". */
function relationSegments(p: RelatedPredicate, many: boolean): Segment[] {
    const v = many ? MANY : ONE
    const meta = axisMeta(p.axis)
    const reach = reachSegments(p)
    const via = viaSegments(p)
    const cond = (several = false): Segment[] => p.where
        ? [txt(' '), { t: 'cond', predicate: p.where, many: several, lead: 'connector' }] : []
    if (p.count) {
        const n = p.count.value
        return [txt(`${v.has} ${COUNT_WORDS[p.count.op ?? 'gte']}`, 'relation'), txt(' '),
            val(String(n), false, 'count'), txt(` ${n === 1 ? meta.noun : meta.plural}`), ...reach,
            ...cond(n !== 1), ...via]
    }
    if (p.quantifier === 'none') {
        return [txt(v.has, 'relation'), txt(' '), { t: 'em', text: 'no', tone: 'not' }, txt(` ${meta.noun}`),
            ...reach, ...cond(), ...via]
    }
    if (p.quantifier === 'all' && p.where) {
        const every: Segment = { t: 'em', text: 'every one', tone: 'every' }
        // "…, every one where type is column"; a verb reads "…, and every one is inside X".
        return connector(p.where) === 'that'
            ? [txt(`${v.has} ${meta.plural}`, 'relation'), ...reach, txt(', and '), every, txt(' '),
                { t: 'cond', predicate: p.where, many: false, lead: 'none' }, ...via]
            : [txt(`${v.has} ${meta.plural}`, 'relation'), ...reach, txt(', '), every, ...cond(), ...via]
    }
    return [txt(`${v.has} a${/^[aeiou]/.test(meta.noun) ? 'n' : ''} ${meta.noun}`, 'relation'),
        ...reach, ...cond(), ...via]
}


/** Each axis as a verb, describing one entity and several: what the
 *  Sentence builder reads a relationship as — "datasets that **feed** a
 *  dashboard", never "have a target that is a dashboard". */
const AXIS_VERB: Record<string, [one: string, many: string]> = {
    parent: ['is directly inside', 'are directly inside'],
    ancestor: ['is inside', 'are inside'],
    root: ['sits under', 'sit under'],
    child: ['directly contains', 'directly contain'],
    descendant: ['contains', 'contain'],
    upstream: ['is fed by', 'are fed by'],
    downstream: ['feeds', 'feed'],
    neighbor: ['is linked to', 'are linked to'],
}

/** A relationship's verb phrase with its quantifier: "feed", "feed no",
 *  "only feed", "are only fed by", "feed at least" — the relative (and,
 *  for a count, its number) follows. */
export function relationVerb(p: RelatedPredicate, many = true): string {
    const [one, several] = AXIS_VERB[p.axis] ?? AXIS_VERB.parent
    const verb = many ? several : one
    if (p.count) return `${verb} ${COUNT_WORDS[p.count.op ?? 'gte']}`
    if (p.quantifier === 'none') return `${verb} no`
    if (p.quantifier === 'all' && p.where) {
        // "are only fed by", "only feed": "only" after a leading are / is.
        const [first, ...rest] = verb.split(' ')
        return first === 'are' || first === 'is' ? [first, 'only', ...rest].join(' ') : `only ${verb}`
    }
    return verb
}


function edgeSegments(ep: EdgePredicateNode): Segment[] {
    if (ep.kind === 'edgeGroup') {
        if (ep.op === 'not') return [{ t: 'em', text: 'NOT', tone: 'not' }, txt(' '), ...edgeSegments(ep.children[0])]
        return joined(ep.children, ep.op === 'or' ? ' or ' : ' and ', edgeSegments)
    }
    if (ep.kind === 'edgeHasProperty') {
        return [txt(ep.negate ? 'there is no ' : 'there is a '), val(ep.key, true, 'edge')]
    }
    const prop = ep as EdgePropertyPredicate
    const op = prop.op ?? 'eq'
    const arity = arityOf(op)
    const type = predicateType({ ...prop, kind: 'property' } as PropertyPredicate)
    const out: Segment[] = [val(prop.key, true, 'edge'), txt(` ${operatorLabel(op, type)}`)]
    if (arity !== 'none' && arity !== 'duration') {
        out.push(txt(' '), ...valueSegments(prop.value, op === 'between',
            BARE_TYPES.has(type) && !TEXT_OPS.has(op), 'edge'))
    }
    return out
}
