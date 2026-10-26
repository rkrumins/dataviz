/**
 * predicateDsl — a tiny human-friendly query language for the AskBar.
 *
 * Power users type filter expressions directly in Code mode; the parser
 * turns them into a tree of predicates that the Visual builder renders
 * as nested condition rows. The stringifier rebuilds the same text from
 * a predicate so Code mode and Visual mode stay in sync.
 *
 * Supported grammar (lower precedence first):
 *
 *   expr   := orExpr
 *   orExpr := andExpr ('OR' andExpr)*
 *   andExpr:= notExpr (('AND' | implicit-whitespace) notExpr)*
 *   notExpr:= ('NOT' | '!') notExpr | atom
 *   atom   := '(' expr ')' | predicateToken
 *
 * Predicate tokens (one each):
 *
 *   bareword                       → text contains "bareword" in name
 *   "quoted phrase"                → text contains "quoted phrase" in name
 *   name CONTAINS "foo"            → text contains "foo" in name
 *   qname:foo  / qualifiedName:foo → text contains "foo" in qualifiedName
 *   description:foo / desc:foo     → text contains "foo" in description
 *   type:dataset                   → entityType IN [dataset]
 *   type:dataset,schemaField       → entityType IN [dataset, schemaField]
 *   type IN (dataset, schemaField) → entityType IN [dataset, schemaField]
 *   tag:PII                        → tag hasAny [PII]
 *   tag:PII,GDPR                   → tag hasAny [PII, GDPR]
 *   tag:"PII data"                 → a quoted value is one value, spaces,
 *                                    commas and all (type: and layer: too)
 *   layer:Source                   → layer = "Source"
 *   layer="Source"                 → layer = "Source"
 *   hasProperty:pii_class          → hasProperty key=pii_class
 *   has:pii_class                  → hasProperty key=pii_class
 *   rowCount > 1000                → property rowCount gt 1000
 *   rowCount=42  / rowCount:42     → property rowCount eq 42
 *   rowCount != 0                  → property rowCount neq 0
 *   owner CONTAINS "fin"           → property owner contains "fin"
 *   owner STARTS WITH fin          → property owner startsWith "fin"
 *   owner ENDS WITH team           → property owner endsWith "team"
 *   tier IN (gold, silver)         → property tier in [gold, silver]
 *   tier NOT IN (bronze)           → property tier notIn [bronze]
 *   rows BETWEEN (10, 20)          → property rows between [10, 20]
 *   rows BETWEEN 10 AND 20         → the same
 *   "Asset Owner" = Bob            → a key with spaces is quoted
 *   owner NOT CONTAINS "test"      → property owner notContains "test"
 *   labels CONTAINS ALL (pii, gold) → property labels containsAll [pii, gold]
 *   owner IS SET / IS NOT SET      → property owner isSet / isNotSet
 *   notes IS EMPTY / IS NOT EMPTY  → property notes isEmpty / isNotEmpty
 *   updated WITHIN LAST 30 DAYS    → property updated withinLast "P30D"
 *   updated WITHIN LAST PT12H      → any ISO 8601 duration
 *   freshnessHours > {slaHours}    → compared with another property of the
 *                                    same entity (=, !=, <, <=, >, >=)
 *   has:owner* / has:*owner*       → hasProperty by name: starts with / contains
 *
 * A comparison may end with suffixes that keep a row's meaning exactly:
 *   … AS NUMBER | TEXT | BOOLEAN | DATE → the type it compares as
 *                                        (written only when the value alone
 *                                        would read as another type)
 *   … MATCH CASE                        → case-sensitive text
 *   … INCLUDING MISSING                 → ≠ / NOT IN / NOT CONTAINS also
 *                                        match entities without the key
 *
 * A value that must stay TEXT but reads like a number, boolean or null
 * ("15", "007", "true") is written quoted, and a quoted value is always
 * text — so Code mode round-trips a property's type, not just its digits.
 * An unquoted integer too long for a double stays its exact digits.
 *   noUpstream / noUpstreamLineage → isRoot edgeClass=lineage
 *   noDownstream                   → isLeaf edgeClass=lineage
 *   noLineage                      → isOrphan edgeClass=lineage
 *   noIncoming / noOutgoing        → isRoot / isLeaf over any link
 *   hasIncoming / hasOutgoing      → at least one link in / out
 *   noLinks / noEdges              → isOrphan over any link / any edge at all
 *   noIncoming[PRODUCES]           → over these edge types instead; also
 *                                    [lineage], [links], [any], [containment]
 *   edges(out) > 10                → degree: more than 10 outgoing links
 *   edges[PRODUCES](in) >= 2       → of these edges (in / out / both)
 *
 * Relationships — a condition on related entities. The word must be
 * followed by ``(`` with no space between (``parent (x)`` is two words):
 *   parent(type:domain)            → related axis=parent where=…
 *   root(name = Sales)             → the top-level container
 *   child(type:column tag:PII)     → also ancestor / descendant
 *   fedBy()                        → fed by anything, through lineage
 *   feeds*..3(type:dashboard)      → 1 to 3 steps; *2..4, *2 (exactly 2),
 *                                    and *2.. (2 levels or more, up or
 *                                    down the tree)
 *   linkedTo(type:glossaryTerm)    → by any edge but the hierarchy's,
 *                                    either way; outgoing / incoming one way
 *   outgoing[PRODUCES](type:dataset) → through these edge types; [links]
 *                                    and [lineage] name a class instead
 *   upstream / downstream / neighbor → older spellings of fedBy / feeds /
 *                                    linkedTo[lineage]
 *   fedBy(…).via(confidence >= 0.8) → every edge walked meets it
 *   every child(description IS NOT EMPTY) → each one does (and one exists)
 *   no fedBy(type:topic)           → none does
 *   count(child(type:column)) > 100 → how many do (distinct entities)
 *
 * Entities by name:
 *   @"Country/United Kingdom"      → is that entity (a path of names from
 *                                    a top-level entity; ** any depth;
 *                                    \/ a slash in a name, \\ a
 *                                    backslash; or a URN)
 *   inside @"Country/United Kingdom" → descendantOf by name
 *
 * A condition the words above can't spell exactly — within N hops, a path, a
 * depth-bounded descendantOf, a case-sensitive or exact text match… — is
 * written as its own JSON, `{"kind": "withinHops", …}`, and read back as it
 * is: Code mode never changes a condition it shows.
 *
 * Examples:
 *
 *   customer AND tag:PII           → AND(text(customer), tag(PII))
 *   t2 AND (account OR opp)        → AND(t2, OR(account, opp))
 *   t2 AND (account OR opp) OR NOT T1
 *     → OR(AND(t2, OR(account, opp)), NOT(T1))
 *   NOT tag:PII AND type:dataset   → AND(NOT(tag(PII)), type(dataset))
 *
 * Whitespace acts as implicit AND between predicates that aren't
 * separated by an explicit operator. Quoted strings, prefixed tokens,
 * and parenthesised sub-expressions are atomic.
 *
 * The parser is intentionally lenient — unknown bareword tokens fall
 * back to a substring text match against ``name``. That means a user
 * can always type a plain word and get a sensible search.
 */
import type {
    Predicate,
    GroupPredicate,
    TextTarget,
    PropertyOp,
    PropertyPredicate,
    DegreePredicate,
    EdgeClass,
    EdgePredicateNode,
    EdgePropertyPredicate,
    NodeRef,
    RelatedPredicate,
} from '@/types/search'
import { OPERATOR_TABLE } from '@/types/generated/searchOperators'

import { arityOf, isNegative, predicateType } from '../typed/operators'
import { type DurationUnit, parseDuration, toDuration } from '../typed/valueCodec'
import type { ValueType } from '../typed/valueTypes'

import { axisMeta, formatNamePath, hopRange, parseNamePath } from './relations'
import type { ShapeKind } from './vocabulary/edgeWords'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseResult {
    /** The parsed predicate tree, or ``null`` for empty input or an error. */
    predicate: Predicate | null
    /** Number of structured leaves recognised (for the parse-feedback chip). */
    recognized: string[]
    /** Bareword fallback runs (for the parse-feedback chip). */
    fallbackText: string[]
    /** Hard parse error message (parens unbalanced, dangling operator, etc.). */
    error?: string
    /** Where in the input the error points (character offsets). */
    errorAt?: { from: number; to: number }
    /** Every token, in order, with the part it played — what an editor
     *  highlights, so its colours always agree with what is parsed. */
    tokens: DslToken[]
}

/** The part a token plays: ``prefixed`` is ``key:value`` in one token. */
export type DslRole =
    | 'keyword' | 'function' | 'ref' | 'field' | 'operator' | 'value'
    | 'prefixed' | 'text' | 'json' | 'punct'

export interface DslToken {
    from: number
    to: number
    role: DslRole
    /** The source text. */
    text: string
}


export function parsePredicate(input: string): ParseResult {
    const tokens = lex(input)
    const recognized: string[] = []
    const fallbackText: string[] = []
    const result = (rest: Pick<ParseResult, 'predicate' | 'error' | 'errorAt'>): ParseResult => ({
        ...rest, recognized, fallbackText, tokens: tokens.map(publicToken),
    })
    if (tokens.length === 0) return result({ predicate: null })
    const unclosed = tokens.find((t) => t.unclosed)
    if (unclosed) {
        const quote = unclosed.raw[unclosed.kind === TokenKind.Ref ? 1 : 0]
        return result({
            predicate: null,
            error: unclosed.kind === TokenKind.Ref
                ? `Close the name with ${quote}: @${quote}…${quote}`
                : unclosed.kind === TokenKind.Word ? 'Close the edge types with ]'
                    : `Close the text with ${quote}`,
            errorAt: { from: unclosed.from, to: unclosed.to },
        })
    }
    const p = new Parser(tokens, recognized, fallbackText, input.length)
    try {
        const pred = p.parseExpr()
        if (p.pos < tokens.length) {
            const extra = tokens[p.pos]
            // Something the grammar can't place — a stray ")" most often.
            return result({
                predicate: null,
                error: `Unexpected ${extra.raw}`,
                errorAt: { from: extra.from, to: extra.to },
            })
        }
        return result({ predicate: simplify(pred) })
    } catch (err) {
        return result({
            predicate: null,
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof DslError ? { errorAt: { from: err.from, to: err.to } } : {}),
        })
    }
}


/** A parse error and the source range it points at. */
class DslError extends Error {
    constructor(message: string, readonly from: number, readonly to: number) {
        super(message)
    }
}


// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

/**
 * Round-trip a predicate back to DSL text.
 *
 * Grouping rule: any AND/OR group that is nested inside another group
 * is wrapped in parentheses, regardless of whether Cypher's
 * precedence rules would let us drop them. The user typed those
 * parens for a reason (clarity over mixed AND/OR), so we keep them in
 * the round-trip. NOT groups stay bare (``NOT x``) because the
 * standard prefix form is unambiguous on its own.
 */
export function stringifyPredicate(p: Predicate | null): string {
    if (!p) return ''
    return formatExpr(p, /*isTopLevel*/ true)
}


function formatExpr(p: Predicate, isTopLevel: boolean): string {
    if (p.kind !== 'group') return formatAtom(p)
    const op = p.op ?? 'and'
    if (op === 'not') {
        const inner = p.children[0]
        if (!inner) return 'NOT ()'
        // The inner expression is no longer at top level; it may need
        // its own parens if it's a multi-child group.
        return `NOT ${formatExpr(inner, /*isTopLevel*/ false)}`
    }
    if (!p.children.length) return ''
    const sep = op === 'or' ? ' OR ' : ' AND '
    const parts = p.children.map((c) => formatExpr(c, /*isTopLevel*/ false))
    const joined = parts.filter(Boolean).join(sep)
    // Top-level group has no enclosing group, so no outer parens.
    // Nested groups are always wrapped — even when Cypher precedence
    // would technically let us drop the parens — so the round-trip
    // mirrors what the user typed.
    return isTopLevel ? joined : `(${joined})`
}


/** One condition as DSL: the first spelling that reads back as this very
 *  condition, or — when none does — the condition itself as JSON, which
 *  always does. A `[withinHops]` once came back as a name search. */
function formatAtom(c: Predicate): string {
    for (const spelling of spellings(c)) {
        const back = parsePredicate(spelling)
        if (!back.error && back.predicate && meaning(back.predicate) === meaning(c)) return spelling
    }
    return JSON.stringify(c)
}


const TEXT_FIELD: Partial<Record<TextTarget, string>> = {
    name: 'name', qualifiedName: 'qname', description: 'description', tags: 'tags',
}
const TEXT_VERB: Record<string, string> = {
    substring: 'CONTAINS', prefix: 'STARTS WITH', suffix: 'ENDS WITH',
}


/** The ways the words can write ``c``, plainest first. */
function spellings(c: Predicate): string[] {
    switch (c.kind) {
        case 'text': {
            const target: TextTarget = (c.target ?? 'name') as TextTarget
            const match = c.match ?? 'substring'
            const out: string[] = []
            // A bare or quoted word is a case-insensitive name search.
            if (target === 'name' && match === 'substring') out.push(c.value, `"${c.value}"`)
            if (target === 'qualifiedName' && match === 'substring') out.push(`qname:${c.value}`)
            if (target === 'description' && match === 'substring') out.push(`description:${c.value}`)
            const field = TEXT_FIELD[target]
            const verb = TEXT_VERB[match]
            if (field && verb) out.push(`${field} ${verb} ${c.value}`, `${field} ${verb} "${c.value}"`)
            return out
        }
        default: {
            const one = spelling(c)
            return one === null ? [] : [one]
        }
    }
}


/** A condition's meaning: every default spelled out, a comparison as the
 *  server compares it — two ways of writing one condition compare equal. */
function meaning(p: Predicate): string {
    switch (p.kind) {
        case 'text':
            return stable(['text', p.value, p.target ?? 'name', p.match ?? 'substring',
                !!p.caseSensitive, p.boost ?? 1, p.propertyKey ?? null])
        case 'tag':
            return stable(['tag', p.op ?? 'hasAny', p.values])
        case 'entityType':
            return stable(['entityType', p.op ?? 'in', p.values])
        case 'hasProperty':
            return stable(['hasProperty', p.key, p.keyMatch ?? 'exact', !!p.negate])
        // Edge types named, the class doesn't count.
        case 'isRoot': case 'isLeaf': case 'isOrphan': case 'hasIncoming': case 'hasOutgoing':
            return stable([p.kind, p.edgeTypes?.length ? null : (p.edgeClass ?? DEFAULT_EDGE_CLASS),
                p.edgeTypes ?? null])
        case 'degree':
            return stable(['degree', p.direction ?? 'both', p.op ?? 'eq', p.value,
                p.edgeTypes?.length ? null : (p.edgeClass ?? DEFAULT_EDGE_CLASS), p.edgeTypes ?? null])
        case 'property': {
            const op = p.op ?? 'eq'
            const arity = arityOf(op)
            return stable(['property', p.key, op, p.valueKey ?? null,
                arity === 'none' ? null : arity === 'duration' ? String(p.value).toUpperCase() : p.value,
                arity === 'none' || OPERATOR_TABLE[op].types.length === 1 ? null : predicateType(p),
                arity !== 'none' && !!p.caseSensitive, isNegative(op) && !!p.includeMissing])
        }
        case 'related': {
            const [lo, hi] = hopRange(p)
            return stable(['related', p.axis, p.count ? null : (p.quantifier ?? 'any'),
                p.count ? [p.count.op ?? 'gte', p.count.value] : null, lo, hi,
                p.edgeTypes ?? null, p.edgeClass === 'links' ? 'links' : null,
                p.edge ? treeMeaning(fromEdge(p.edge)) : null,
                p.where ? treeMeaning(p.where) : null])
        }
        case 'is':
            return stable(['is', p.refs.map((r) => [r.urn ?? null, r.path ?? null,
                r.entityType ?? null, r.caseSensitive ?? true])])
        case 'descendantOf':
            // Named by path, it is edited by name whether or not it says so.
            return p.refs?.length && !p.urns?.length ? stable({ ...p, uiScope: 'name' }) : stable(p)
        case 'group': {
            // `not has:x` reads back as NOT around the name test.
            const only = p.children.length === 1 ? p.children[0] : null
            if (p.op === 'not' && only?.kind === 'hasProperty') {
                return meaning({ ...only, negate: !only.negate })
            }
            return stable(p)
        }
        default:
            return stable(p)
    }
}


function refSpelling(ref: NodeRef): string {
    return ref.urn ?? formatNamePath(ref.path ?? [])
}


/** ``parent(…)``, ``every child(…)``, ``feeds*..3(…).via(…)``,
 *  ``outgoing[PRODUCES](…)``, ``count(child(…)) > 3``. */
function relationSpelling(p: RelatedPredicate): string {
    const meta = axisMeta(p.axis)
    let hops = ''
    if (meta.hops) {
        const [lo, hi] = hopRange(p)
        if (meta.lineage) {
            hops = lo === 1 && hi === 1 ? '' : lo === hi ? `*${hi}` : lo === 1 ? `*..${hi}` : `*${lo}..${hi}`
        } else if (p.maxHops) {
            hops = lo === 1 ? `*..${hi}` : `*${lo}..${hi}`
        } else if (lo > 1) {
            hops = `*${lo}..`
        }
    }
    let text = `${relationWord(p)}${hops}(${p.where ? stringifyPredicate(p.where) : ''})`
    if (p.edge) text += `.via(${stringifyPredicate(fromEdge(p.edge))})`
    if (p.count) return `count(${text}) ${COUNT_SYMBOLS[p.count.op ?? 'gte']} ${p.count.value}`
    if (p.quantifier === 'none') return `no ${text}`
    if (p.quantifier === 'all') return `every ${text}`
    return text
}


/** The word a relationship opens with: the hierarchy's axis, feeds / fedBy
 *  for lineage one way, and the neutral link words for anything else — an
 *  edge type's direction isn't always the way data flows. */
function relationWord(p: RelatedPredicate): string {
    if (!axisMeta(p.axis).lineage) return p.axis
    const link = LINK_WORDS[p.axis as keyof typeof LINK_WORDS]
    if (p.edgeTypes) return `${link}[${p.edgeTypes.join(', ')}]`
    if (p.edgeClass === 'links') return link
    return p.axis === 'upstream' ? 'fedBy' : p.axis === 'downstream' ? 'feeds' : 'linkedTo[lineage]'
}

const LINK_WORDS = { upstream: 'incoming', downstream: 'outgoing', neighbor: 'linkedTo' } as const


/** A graph shape's word over lineage and over any link. */
const SHAPE_SPELLINGS: Record<ShapeKind, { lineage: string; links: string }> = {
    isRoot: { lineage: 'noUpstream', links: 'noIncoming' },
    isLeaf: { lineage: 'noDownstream', links: 'noOutgoing' },
    isOrphan: { lineage: 'noLineage', links: 'noLinks' },
    hasIncoming: { lineage: 'hasUpstream', links: 'hasIncoming' },
    hasOutgoing: { lineage: 'hasDownstream', links: 'hasOutgoing' },
}

/** ``noUpstream``, ``noIncoming``, ``noEdges``, ``noIncoming[PRODUCES]``. */
function shapeSpelling(kind: ShapeKind, c: { edgeClass?: EdgeClass | null; edgeTypes?: string[] | null }): string {
    const words = SHAPE_SPELLINGS[kind]
    const neutral = kind === 'isOrphan' ? 'noEdges' : words.links
    if (c.edgeTypes) return `${neutral}[${c.edgeTypes.join(', ')}]`
    const set = c.edgeClass ?? DEFAULT_EDGE_CLASS
    if (set === 'lineage' || set === 'links') return words[set]
    return kind === 'isOrphan' && set === 'any' ? 'noEdges' : `${neutral}[${set}]`
}

/** ``edges(out) > 10`` — any link unless the brackets say otherwise. */
function degreeSpelling(c: DegreePredicate): string {
    const set = c.edgeTypes ? `[${c.edgeTypes.join(', ')}]`
        : c.edgeClass === 'links' ? '' : `[${c.edgeClass ?? DEFAULT_EDGE_CLASS}]`
    return `edges${set}(${c.direction ?? 'both'}) ${COUNT_SYMBOLS[c.op ?? 'eq']} ${c.value}`
}


/** A nested condition's meaning: groups as the parser regroups them, by
 *  their members' meanings. */
function treeMeaning(p: Predicate): string {
    const s = simplify(p)
    if (s.kind !== 'group' || (s.op === 'not' && s.children[0]?.kind === 'hasProperty')) return meaning(s)
    return stable(['group', s.op ?? 'and', s.children.map(treeMeaning)])
}


/** JSON with keys in order and undefined fields dropped. */
function stable(v: unknown): string {
    return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
}


/** ``tag:a,b`` — or, a value that must be quoted, ``tag:"PII data"``, and
 *  several with one of those, ``tag IN ("PII data", GDPR)``. */
function listedValues(field: 'type' | 'tag', values: string[]): string {
    if (!values.some(needsQuotes)) return `${field}:${values.join(',')}`
    if (values.length === 1) return `${field}:"${values[0]}"`
    return `${field} IN (${values.map((v) => (needsQuotes(v) ? `"${v}"` : v)).join(', ')})`
}


/** The one way the words write a condition that isn't text, or null. */
function spelling(c: Predicate): string | null {
    switch (c.kind) {
        case 'entityType': {
            if (c.op !== 'notIn') return listedValues('type', c.values)
            return `type NOT IN (${c.values.join(', ')})`
        }
        case 'tag': {
            const op = c.op
            if (op === 'hasAll') return `tag ALL (${c.values.join(', ')})`
            if (op === 'notHas') return `tag NOT IN (${c.values.join(', ')})`
            return listedValues('tag', c.values)
        }
        case 'layer':
            return `layer:${needsQuotes(c.layerAssignment) ? `"${c.layerAssignment}"` : c.layerAssignment}`
        case 'hasProperty': {
            const name = c.keyMatch === 'prefix' ? `${c.key}*`
                : c.keyMatch === 'contains' ? `*${c.key}*` : c.key
            return c.negate ? `not has:${name}` : `hasProperty:${name}`
        }
        case 'property': {
            const key = needsQuotes(c.key) ? `"${c.key}"` : c.key
            if (c.valueKey != null) return `${key} ${PROP_OP_STR[c.op ?? 'eq']} {${c.valueKey}}${formatSuffixes(c)}`
            return `${key} ${formatComparison(c)}${formatSuffixes(c)}`
        }
        case 'isRoot': case 'isLeaf': case 'isOrphan': case 'hasIncoming': case 'hasOutgoing':
            return shapeSpelling(c.kind, c)
        case 'degree':
            return degreeSpelling(c)
        case 'related':
            return relationSpelling(c)
        case 'is': {
            const [ref] = c.refs
            return c.refs.length === 1 && ref && !ref.entityType && ref.caseSensitive !== false
                ? `@"${refSpelling(ref)}"` : null
        }
        case 'descendantOf': {
            if (c.refs?.length === 1 && !c.urns?.length && !c.maxDepth) {
                const [ref] = c.refs
                return !ref.entityType && ref.caseSensitive !== false
                    ? `inside @"${refSpelling(ref)}"` : null
            }
            // URNs always contain `:`, so quote unconditionally — the
            // prefix lexer would otherwise misread `urn:foo:bar` as a
            // `urn:` prefixed token. One with a maxDepth doesn't read back
            // from this, so it is written as JSON (``formatAtom``).
            if (!c.urns?.length) return null
            const quoted = c.urns.map((u) => `"${u}"`).join(', ')
            return `descendantOf IN (${quoted})`
        }
        default:
            return null
    }
}


// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const enum TokenKind {
    Word = 'word',           // bareword, prefixed token, identifier
    Quoted = 'quoted',       // "value" or 'value' — value stripped of quotes
    Op = 'op',               // = != < <= > >= one-token
    LParen = 'lparen',
    RParen = 'rparen',
    Comma = 'comma',
    AndKw = 'and',
    OrKw = 'or',
    NotKw = 'not',
    Json = 'json',           // {…}: a condition written as its own JSON
    Ref = 'ref',             // @"…": an entity named by its path
    Call = 'call',           // parent( / count( / .via( — the paren consumed
    KeyRef = 'keyref',       // {slaHours}: another property of the same entity
}

interface Token {
    kind: TokenKind
    text: string  // canonical text (no quotes for Quoted)
    raw: string   // original source for diagnostics
    from: number  // where it starts in the input
    to: number    // just past where it ends
    role?: DslRole       // what the parser read it as
    unclosed?: boolean   // a quote or @"…" never closed
}


/** What a token is when the parser said nothing more about it. */
const LEXICAL_ROLE: Record<TokenKind, DslRole> = {
    [TokenKind.Word]: 'text', [TokenKind.Quoted]: 'value', [TokenKind.Op]: 'operator',
    [TokenKind.LParen]: 'punct', [TokenKind.RParen]: 'punct', [TokenKind.Comma]: 'punct',
    [TokenKind.AndKw]: 'keyword', [TokenKind.OrKw]: 'keyword', [TokenKind.NotKw]: 'keyword',
    [TokenKind.Json]: 'json', [TokenKind.Ref]: 'ref', [TokenKind.Call]: 'function',
    [TokenKind.KeyRef]: 'field',
}


function publicToken(t: Token): DslToken {
    return { from: t.from, to: t.to, role: t.role ?? LEXICAL_ROLE[t.kind], text: t.raw }
}


function lex(input: string): Token[] {
    const out: Token[] = []
    let i = 0
    while (i < input.length) {
        const ch = input[i]
        if (/\s/.test(ch)) { i += 1; continue }
        if (ch === '@' && (input[i + 1] === '"' || input[i + 1] === "'")) {
            const close = input.indexOf(input[i + 1], i + 2)
            const end = close === -1 ? input.length : close
            out.push({
                kind: TokenKind.Ref, text: input.slice(i + 2, end), raw: input.slice(i, end + 1),
                from: i, to: Math.min(end + 1, input.length), ...(close === -1 ? { unclosed: true } : {}),
            })
            i = end + 1
            continue
        }
        if (ch === '"' || ch === "'") {
            const close = input.indexOf(ch, i + 1)
            if (close === -1) {
                out.push({
                    kind: TokenKind.Quoted, text: input.slice(i + 1), raw: input.slice(i),
                    from: i, to: input.length, unclosed: true,
                })
                i = input.length
                continue
            }
            out.push({
                kind: TokenKind.Quoted,
                text: input.slice(i + 1, close),
                raw: input.slice(i, close + 1),
                from: i, to: close + 1,
            })
            i = close + 1
            continue
        }
        if (ch === '{') {
            // {slaHours}: another property — a name, no quote or colon in it.
            const key = /^\{([^{}":]+)\}/.exec(input.slice(i))
            if (key && key[1].trim()) {
                out.push({ kind: TokenKind.KeyRef, text: key[1].trim(), raw: key[0], from: i, to: i + key[0].length })
                i += key[0].length
                continue
            }
            // A condition as JSON: to its matching brace, strings and all.
            const end = jsonEnd(input, i)
            const text = input.slice(i, end)
            out.push({ kind: TokenKind.Json, text, raw: text, from: i, to: end })
            i = end
            continue
        }
        if (ch === '(' || ch === ')' || ch === ',') {
            out.push({
                kind: ch === '(' ? TokenKind.LParen
                    : ch === ')' ? TokenKind.RParen
                        : TokenKind.Comma,
                text: ch,
                raw: ch,
                from: i, to: i + 1,
            })
            i += 1
            continue
        }
        // 2-char operators
        if ((ch === '!' || ch === '<' || ch === '>' || ch === '=') && input[i + 1] === '=') {
            const t = input.slice(i, i + 2)
            out.push({ kind: TokenKind.Op, text: t, raw: t, from: i, to: i + 2 })
            i += 2
            continue
        }
        if (ch === '=' || ch === '<' || ch === '>') {
            out.push({ kind: TokenKind.Op, text: ch, raw: ch, from: i, to: i + 1 })
            i += 1
            continue
        }
        // Standalone NOT-bang
        if (ch === '!') {
            out.push({ kind: TokenKind.NotKw, text: '!', raw: '!', from: i, to: i + 1 })
            i += 1
            continue
        }
        // Bareword — read until whitespace, operator, paren, comma, or quote.
        // A comma inside ``prefix:a,b`` is part of its list of values, and
        // so is anything in the brackets of a word that takes edge types:
        // ``outgoing[PRODUCES, CONSUMES](``.
        let j = i
        let unclosed = false
        while (j < input.length) {
            const c = input[j]
            if (/\s/.test(c)) break
            if (c === '"' || c === "'") break
            if (c === ',' && input.slice(i, j).includes(':') && j + 1 < input.length
                && !/[\s(),"'!=<>]/.test(input[j + 1])) {
                j += 1
                continue
            }
            if (c === '[' && EDGE_WORD.test(input.slice(i, j).replace(/[_-]/g, ''))) {
                const close = input.indexOf(']', j)
                unclosed = close === -1
                j = unclosed ? input.length : close + 1
                continue
            }
            if (c === '(' || c === ')' || c === ',' || c === '!') break
            if (c === '=' || c === '<' || c === '>') break
            j += 1
        }
        if (j > i && input[j] === '(' && CALL_WORD.test(input.slice(i, j))) {
            const word = input.slice(i, j)
            out.push({ kind: TokenKind.Call, text: word.toLowerCase(), raw: `${word}(`, from: i, to: j + 1 })
            i = j + 1
            continue
        }
        if (j > i) {
            const word = input.slice(i, j)
            const up = word.toUpperCase()
            // Bare keywords are reserved only when they stand alone —
            // ``AND`` ``OR`` ``NOT``. Anything containing a colon, dot,
            // or other operator-y char is treated as a token even if
            // the prefix matches.
            const at = { from: i, to: j }
            if ((up === 'AND' || up === '&&') && !word.includes(':')) {
                out.push({ kind: TokenKind.AndKw, text: 'AND', raw: word, ...at })
            } else if (up === 'OR' && !word.includes(':')) {
                out.push({ kind: TokenKind.OrKw, text: 'OR', raw: word, ...at })
            } else if (up === 'NOT' && !word.includes(':')) {
                out.push({ kind: TokenKind.NotKw, text: 'NOT', raw: word, ...at })
            } else {
                out.push({ kind: TokenKind.Word, text: word, raw: word, ...at, ...(unclosed ? { unclosed } : {}) })
            }
            i = j
        } else {
            i += 1
        }
    }
    return out
}


const COUNT_OPS: Record<string, NonNullable<NonNullable<RelatedPredicate['count']>['op']>> = {
    '=': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
}
const COUNT_SYMBOLS: Record<string, string> = {
    eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
}


/** ``@"…"``: a URN, or a path of names. */
function refOf(text: string): NodeRef {
    return /^urn:/i.test(text.trim()) ? { urn: text.trim() } : { path: parseNamePath(text) }
}


/** ``.via(…)``'s condition, read as one on an edge's properties. */
function toEdge(p: Predicate): EdgePredicateNode {
    if (p.kind === 'property') {
        const { kind: _k, ...rest } = p
        return { ...rest, kind: 'edgeProperty' }
    }
    if (p.kind === 'hasProperty' && (p.keyMatch ?? 'exact') === 'exact') {
        return { kind: 'edgeHasProperty', key: p.key, ...(p.negate ? { negate: true } : {}) }
    }
    if (p.kind === 'group') {
        // `not has:x` is NOT around the presence test.
        return { kind: 'edgeGroup', op: p.op ?? 'and', children: p.children.map(toEdge) }
    }
    throw new Error('.via(…) tests the edges walked: a property comparison or has:key')
}


/** An edge filter written as the conditions ``.via(…)`` reads. */
function fromEdge(e: EdgePredicateNode): Predicate {
    if (e.kind === 'edgeGroup') {
        return { kind: 'group', op: e.op ?? 'and', children: e.children.map(fromEdge) }
    }
    if (e.kind === 'edgeHasProperty') {
        return { kind: 'hasProperty', key: e.key, ...(e.negate ? { negate: true } : {}) }
    }
    const { kind: _k, ...rest } = e as EdgePropertyPredicate
    return { ...rest, kind: 'property' }
}


/** Words a comparison is spelled with — highlighted as keywords. */
const TAIL_KEYWORDS = new Set([
    'IS', 'SET', 'EMPTY', 'WITHIN', 'LAST', 'CONTAINS', 'ALL', 'STARTS', 'ENDS', 'WITH',
    'IN', 'BETWEEN', 'AND', 'AS', 'MATCH', 'CASE', 'INCLUDING', 'MISSING',
    'NUMBER', 'TEXT', 'BOOLEAN', 'DATE',
    'MINUTE', 'MINUTES', 'HOUR', 'HOURS', 'DAY', 'DAYS', 'WEEK', 'WEEKS', 'MONTH', 'MONTHS',
    'YEAR', 'YEARS',
])


/** A word that opens a relationship, a count, an edge count or an edge
 *  filter when ``(`` follows it directly. A relationship's edges may come
 *  in brackets before or after its steps: ``outgoing[PRODUCES]*..3(``. */
const CALL_WORD = /^((parent|child|ancestor|descendant|root|upstream|downstream|neighbor|feeds|fedby|linkedto|outgoing|incoming)(\[[^\]]*\])?(\*\d*(\.\.\d*)?)?(\[[^\]]*\])?|edges(\[[^\]]*\])?|count|\.via)$/i

/** A word that takes edge types in brackets — the hierarchy's too, to be
 *  told it doesn't. Read with ``_`` and ``-`` left out. */
const EDGE_WORD = /^((parent|child|ancestor|descendant|root|upstream|downstream|neighbor|feeds|fedby|linkedto|outgoing|incoming)(\*\d*(\.\.\d*)?)?|edges|noupstream(lineage)?|nodownstream(lineage)?|nolineage|orphans?|hasupstream|hasdownstream|noincoming|nooutgoing|nolinks|noedges|hasincoming|hasoutgoing)$/i

/** A relationship's call, as typed: word, [edges], *steps, [edges]. */
const RELATION_CALL = /^([a-z]+)(?:\[([^\]]*)\])?(?:(\*)(\d*)(\.\.)?(\d*))?(?:\[([^\]]*)\])?$/i

/** A relationship word: the axis it follows, and whether over any link. */
const RELATION_WORDS: Record<string, { axis: RelatedPredicate['axis']; links?: true }> = {
    parent: { axis: 'parent' }, child: { axis: 'child' }, ancestor: { axis: 'ancestor' },
    descendant: { axis: 'descendant' }, root: { axis: 'root' },
    upstream: { axis: 'upstream' }, downstream: { axis: 'downstream' }, neighbor: { axis: 'neighbor' },
    fedby: { axis: 'upstream' }, feeds: { axis: 'downstream' },
    incoming: { axis: 'upstream', links: true }, outgoing: { axis: 'downstream', links: true },
    linkedto: { axis: 'neighbor', links: true },
}

/** The classes ``[…]`` may name on a connection, and on a shape or count. */
const LINK_CLASSES: readonly EdgeClass[] = ['lineage', 'links']
const SHAPE_CLASSES: readonly EdgeClass[] = ['lineage', 'links', 'any', 'containment']

/** What ``[…]`` names: one class of edges, or edge types. */
function readEdgeSet(content: string, classes: readonly EdgeClass[]): { edgeClass?: EdgeClass; edgeTypes?: string[] } {
    const names = content.split(',').map((n) => n.trim()).filter(Boolean)
    if (!names.length) throw new Error('Name edge types between the brackets: outgoing[PRODUCES](…)')
    const named = names.map((n) => n.toLowerCase()).filter((n) => SHAPE_CLASSES.includes(n as EdgeClass))
    if (!named.length) return { edgeTypes: names }
    const list = classes.map((c) => `[${c}]`).join(', ')
    if (names.length > 1) throw new Error(`Name edge types, or one of ${list} — not both`)
    if (!classes.includes(named[0] as EdgeClass)) {
        throw new Error(`A connection follows ${list} or edge types, not [${named[0]}]`)
    }
    return { edgeClass: named[0] as EdgeClass }
}

/** A call that opens a relationship — not count(, .via( or edges(. */
function opensRelation(t: Token | null | undefined): t is Token {
    return t?.kind === TokenKind.Call && t.text !== 'count' && t.text !== '.via' && !/^edges\b/.test(t.text)
}

const DEGREE_DIRECTIONS: Record<string, NonNullable<DegreePredicate['direction']>> = {
    in: 'in', out: 'out', both: 'both',
}


/** Just past the ``}`` closing the JSON object that opens at ``start`` —
 *  or the input's end, when nothing closes it (the parser then refuses it). */
function jsonEnd(input: string, start: number): number {
    let depth = 0
    let inString = false
    for (let i = start; i < input.length; i += 1) {
        const c = input[i]
        if (inString) {
            if (c === '\\') i += 1
            else if (c === '"') inString = false
        } else if (c === '"') {
            inString = true
        } else if (c === '{' || c === '[') {
            depth += 1
        } else if (c === '}' || c === ']') {
            depth -= 1
            if (depth === 0) return i + 1
        }
    }
    return input.length
}


// ---------------------------------------------------------------------------
// Recursive-descent parser
//
//   expr   := orExpr
//   orExpr := andExpr ('OR' andExpr)*
//   andExpr:= notExpr (('AND' | implicit) notExpr)*
//   notExpr:= ('NOT' | '!') notExpr | atom
//   atom   := '(' expr ')' | tokenPredicate
// ---------------------------------------------------------------------------

class Parser {
    pos = 0
    constructor(
        readonly tokens: Token[],
        readonly recognized: string[],
        readonly fallbackText: string[],
        /** The input's length: where "it ended too soon" points. */
        readonly length: number,
    ) {}

    peek(): Token | null {
        return this.tokens[this.pos] ?? null
    }

    consume(): Token {
        return this.tokens[this.pos++]
    }

    /** Stop with ``message``, pointing at ``at`` — or at the token under the
     *  cursor, or the end of the input when there is none. */
    fail(message: string, at?: Token | null): never {
        const t = at ?? this.peek()
        throw t ? new DslError(message, t.from, t.to) : new DslError(message, this.length, this.length)
    }

    /** Say what ``tokens[from, to)`` were read as: keywords as keywords,
     *  punctuation as punctuation, the rest as values. */
    markTail(from: number, to: number): void {
        for (let i = from; i < to; i += 1) {
            const t = this.tokens[i]
            if (t.kind === TokenKind.NotKw || t.kind === TokenKind.AndKw
                || (t.kind === TokenKind.Word && TAIL_KEYWORDS.has(t.text.toUpperCase()))) t.role = 'keyword'
            else if (t.kind === TokenKind.LParen || t.kind === TokenKind.RParen
                     || t.kind === TokenKind.Comma) t.role = 'punct'
            else if (t.kind === TokenKind.Op) t.role = 'operator'
            else t.role = 'value'
        }
    }

    parseExpr(): Predicate {
        return this.parseOr()
    }

    parseOr(): Predicate {
        const left = this.parseAnd()
        const parts: Predicate[] = [left]
        while (this.peek()?.kind === TokenKind.OrKw) {
            this.consume()  // OR
            parts.push(this.parseAnd())
        }
        if (parts.length === 1) return parts[0]
        return { kind: 'group', op: 'or', children: parts }
    }

    parseAnd(): Predicate {
        const left = this.parseNot()
        const parts: Predicate[] = [left]
        while (true) {
            const t = this.peek()
            if (!t) break
            // Explicit AND advances the cursor.
            if (t.kind === TokenKind.AndKw) {
                this.consume()
            } else if (
                // Implicit AND: ANY atom-starting token that isn't a binary
                // operator. NOT and '(' and any atom-token start a new
                // factor and bind tighter than OR.
                t.kind === TokenKind.OrKw
                || t.kind === TokenKind.RParen
            ) {
                break
            }
            // Don't double-consume AND for the implicit case — we just
            // proceed to parse another factor.
            const next = this.tryParseNot()
            if (next == null) break
            parts.push(next)
        }
        if (parts.length === 1) return parts[0]
        return { kind: 'group', op: 'and', children: parts }
    }

    parseNot(): Predicate {
        const t = this.peek()
        if (t?.kind === TokenKind.NotKw) {
            this.consume()
            const inner = this.parseNot()
            return { kind: 'group', op: 'not', children: [inner] }
        }
        return this.parseAtom()
    }

    /** Try-parse: returns null if no atom is at the current position
     *  (used by the implicit-AND loop to know when to stop). */
    tryParseNot(): Predicate | null {
        const t = this.peek()
        if (!t) return null
        if (t.kind === TokenKind.RParen) return null
        if (t.kind === TokenKind.OrKw) return null
        if (t.kind === TokenKind.AndKw) {
            this.consume()
            return this.parseNot()
        }
        return this.parseNot()
    }

    parseAtom(): Predicate {
        const t = this.peek()
        if (!t) this.fail('The query ends too soon: a condition should follow', null)
        if (t.kind === TokenKind.LParen) {
            this.consume()
            const inner = this.parseExpr()
            const closing = this.peek()
            if (!closing || closing.kind !== TokenKind.RParen) {
                this.fail('Missing ")" to close this "("', t)
            }
            this.consume()
            return inner
        }
        // Predicate token — may consume up to 3 tokens (e.g. `name CONTAINS x`).
        return this.parsePredicateToken()
    }

    parsePredicateToken(): Predicate {
        const t = this.consume()

        if (t.kind === TokenKind.KeyRef) {
            this.fail(`{${t.text}} compares a property with another: freshnessHours > {slaHours}`, t)
        }
        // Relationships, counts and entities by name.
        if (t.kind === TokenKind.Call) return this.parseCall(t)
        if (t.kind === TokenKind.Ref) {
            this.recognized.push(t.raw)
            return { kind: 'is', refs: [refOf(t.text)] }
        }
        if (t.kind === TokenKind.Word) {
            const word = t.text.toLowerCase()
            const next = this.peek()
            if (word === 'inside' && next?.kind === TokenKind.Ref) {
                this.consume()
                t.role = 'keyword'
                this.recognized.push(`${t.raw} ${next.raw}`)
                return { kind: 'descendantOf', urns: [], refs: [refOf(next.text)], uiScope: 'name' } as Predicate
            }
            if ((word === 'every' || word === 'no') && opensRelation(next)) {
                this.consume()
                t.role = 'keyword'
                return this.parseRelation(next, word === 'no' ? 'none' : 'all')
            }
        }

        // 0) A condition written as its own JSON — read back as it is, or
        //    refused: never searched for as a name.
        if (t.kind === TokenKind.Json) {
            let value: unknown
            try {
                value = JSON.parse(t.text)
            } catch {
                value = null
            }
            const kind = (value as { kind?: unknown } | null)?.kind
            if (!value || typeof value !== 'object' || Array.isArray(value) || typeof kind !== 'string') {
                this.fail('Not a condition written as JSON: it needs a "kind"', t)
            }
            this.recognized.push(kind)
            return value as Predicate
        }

        // 1) boolean-shaped bareword (noUpstream, noIncoming[PRODUCES], etc.)
        if (t.kind === TokenKind.Word) {
            const bool = this.read(() => matchBooleanToken(t.text), t)
            if (bool) {
                t.role = 'keyword'
                this.recognized.push(t.text)
                return bool
            }
        }

        // 2a) `key IS [NOT] SET|EMPTY`, `key WITHIN LAST …`,
        //     `key CONTAINS ALL (…)`, `key NOT CONTAINS x`
        if (t.kind === TokenKind.Word || t.kind === TokenKind.Quoted) {
            const tail = this.tryConsumePropertyTail(t)
            if (tail) return tail
        }

        // 2) `lhs CONTAINS | STARTS WITH | ENDS WITH rhs` — on a text field
        //    (name, qname, description, tags) a text predicate, on anything
        //    else a property predicate. A quoted lhs is always a property key.
        if (t.kind === TokenKind.Word || t.kind === TokenKind.Quoted) {
            const checkpoint = this.pos
            const textOp = this.tryConsumeTextOperator()
            const rhs = textOp ? this.peek() : null
            // Without a value this is ordinary words ("sales contains") —
            // the lenient fallback below reads them as text.
            if (textOp && rhs && (rhs.kind === TokenKind.Word || rhs.kind === TokenKind.Quoted)
                && !(t.kind === TokenKind.Word && lhsToTextTarget(t.text) && !rhs.text.trim())) {
                this.consume()
                t.role = 'field'
                this.markTail(checkpoint, this.pos)
                const target = t.kind === TokenKind.Word ? lhsToTextTarget(t.text) : null
                this.recognized.push(`${t.raw} ${textOp.raw} ${rhs.raw}`)
                if (target) {
                    const value = rhs.text.trim()
                    return {
                        ...makeTextPredicate(target, value),
                        match: textOp.op === 'contains' ? 'substring'
                            : textOp.op === 'startsWith' ? 'prefix' : 'suffix',
                    } as Predicate
                }
                return this.consumeSuffixes({ kind: 'property', key: t.text, op: textOp.op, value: rhs.text })
            }
            this.pos = checkpoint
        }

        // 3) `type [NOT] IN ( a, b, c )` — and `key [NOT] IN (…)` for a property
        if (t.kind === TokenKind.Word || t.kind === TokenKind.Quoted) {
            const before = this.pos
            const inResult = this.tryConsumeInExpression(t.text, t.kind === TokenKind.Quoted)
            if (inResult) {
                t.role = 'field'
                this.markTail(before, this.pos)
                this.recognized.push(inResult.label)
                return inResult.predicate.kind === 'property'
                    ? this.consumeSuffixes(inResult.predicate)
                    : inResult.predicate
            }
            const between = this.tryConsumeBetween(t)
            if (between) return between
        }

        // 4) `key OP value` (eq / neq / lt / lte / gt / gte)
        if (t.kind === TokenKind.Word || t.kind === TokenKind.Quoted) {
            const opT = this.peek()
            if (opT?.kind === TokenKind.Op) {
                const propOp = OP_MAP[opT.text]
                if (propOp) {
                    this.consume()  // op
                    const valT = this.peek()
                    if (valT?.kind === TokenKind.KeyRef) {
                        this.consume()
                        t.role = 'field'
                        opT.role = 'operator'
                        this.recognized.push(`${t.text} ${opT.text} ${valT.raw}`)
                        const compared = this.consumeSuffixes({ kind: 'property', key: t.text, op: propOp,
                                                                valueKey: valT.text })
                        if (compared.includeMissing) {
                            this.fail('Comparing two properties needs both: INCLUDING MISSING doesn\'t apply', valT)
                        }
                        return compared
                    }
                    if (!valT || (valT.kind !== TokenKind.Word && valT.kind !== TokenKind.Quoted)) {
                        this.fail(`Expected a value after ${t.raw} ${opT.raw}`, valT ?? opT)
                    }
                    this.consume()
                    t.role = 'field'
                    opT.role = 'operator'
                    valT.role = 'value'
                    const rawValue = valT.kind === TokenKind.Quoted ? valT.text : valT.text
                    this.recognized.push(`${t.text} ${opT.text} ${valT.raw}`)
                    // `layer = "X"` is a layer predicate
                    if (t.kind === TokenKind.Word && t.text.toLowerCase() === 'layer' && propOp === 'eq') {
                        return { kind: 'layer', layerAssignment: rawValue }
                    }
                    return this.consumeSuffixes({
                        kind: 'property',
                        key: t.text,
                        op: propOp,
                        value: coerceScalar(rawValue, valT.kind === TokenKind.Quoted),
                    })
                }
            }
        }

        // 5) `prefix:value` (single token containing a colon), or
        // `prefix:"a value"` — quoted right after the colon, kept whole
        if (t.kind === TokenKind.Word && t.text.includes(':')) {
            const next = this.peek()
            const quoted = t.text.endsWith(':') && next?.kind === TokenKind.Quoted && next.from === t.to
                ? next : null
            const prefixed = matchPrefixedToken(t.text, quoted?.text)
            if (prefixed) {
                t.role = 'prefixed'
                if (quoted) {
                    this.consume()
                    quoted.role = 'prefixed'
                }
                this.recognized.push(quoted ? `${t.text}${quoted.raw}` : t.text)
                return prefixed
            }
        }

        // 6) Bareword / quoted → substring text predicate against name
        const value = (t.kind === TokenKind.Quoted ? t.text : t.text).trim()
        if (!value || t.kind === TokenKind.Op || t.kind === TokenKind.RParen
            || t.kind === TokenKind.Comma) {
            // An operator or bracket with nothing to compare — not a name.
            this.fail(t.kind === TokenKind.Quoted ? 'Empty quotes: put text between them'
                : `Unexpected ${t.raw}`, t)
        }
        t.role = 'text'
        this.fallbackText.push(value)
        return makeTextPredicate('name', value)
    }

    /** A relationship, or ``count(<relationship>) <op> <n>``; its ``(`` is
     *  already consumed. */
    parseCall(t: Token): Predicate {
        if (t.text === '.via') this.fail('.via( follows a relationship: fedBy(…).via(…)', t)
        if (/^edges\b/.test(t.text)) return this.parseDegree(t)
        if (t.text !== 'count') return this.parseRelation(t)
        t.role = 'function'
        const inner = this.consume()
        if (!opensRelation(inner)) {
            this.fail('count( takes a relationship: count(child(type:column)) > 10', inner ?? t)
        }
        const rel = this.parseRelation(inner) as RelatedPredicate
        this.expectClose('count(')
        const opT = this.consume()
        const op = opT?.kind === TokenKind.Op ? COUNT_OPS[opT.text] : undefined
        const valT = this.consume()
        const value = valT ? Number(valT.text) : NaN
        if (!op || !Number.isInteger(value) || value < 0) {
            this.fail('count(…) compares to a whole number: count(child()) >= 3', valT ?? opT ?? t)
        }
        opT.role = 'operator'
        valT.role = 'value'
        this.recognized.push(`count(…) ${opT.text} ${value}`)
        return { ...rel, count: { op, value } }
    }

    /** ``edges[…](in|out|both) <op> <n>``; its ``(`` is already consumed. */
    parseDegree(t: Token): Predicate {
        t.role = 'function'
        const bracket = /\[([^\]]*)\]/.exec(t.raw)?.[1]
        const edges = bracket === undefined ? { edgeClass: 'links' as const }
            : this.read(() => readEdgeSet(bracket, SHAPE_CLASSES), t)
        const dirT = this.consume()
        const direction = dirT?.kind === TokenKind.Word ? DEGREE_DIRECTIONS[dirT.text.toLowerCase()] : undefined
        if (!direction) this.fail('Say which way: edges(in), edges(out) or edges(both)', dirT ?? t)
        dirT.role = 'keyword'
        this.expectClose('edges(…')
        const opT = this.consume()
        const op = opT?.kind === TokenKind.Op ? COUNT_OPS[opT.text] : undefined
        const valT = this.consume()
        const value = valT ? Number(valT.text) : NaN
        if (!op || !Number.isInteger(value) || value < 0) {
            this.fail('edges(…) compares to a whole number: edges(out) > 10', valT ?? opT ?? t)
        }
        opT.role = 'operator'
        valT.role = 'value'
        this.recognized.push(`${t.raw}${dirT.raw}) ${opT.text} ${value}`)
        return { kind: 'degree', direction, op, value, ...edges }
    }

    parseRelation(t: Token, quantifier?: 'none' | 'all'): Predicate {
        // As typed: edge types keep their case.
        const m = RELATION_CALL.exec(t.raw.slice(0, -1))
        const word = m ? RELATION_WORDS[m[1].toLowerCase()] : undefined
        if (!m || !word) this.fail(`Not a relationship: ${t.raw}`, t)
        t.role = 'function'
        const { axis } = word
        const [, name, before, star, first, dots, second, after] = m
        const meta = axisMeta(axis)
        if (star && !meta.hops) this.fail(`${name}( takes no hop range`, t)
        if (star && !first && !second) this.fail(`Say how far: ${name}*..3(…)`, t)
        if (before !== undefined && after !== undefined) this.fail(`Name its edges once: ${name}[…](…)`, t)
        const bracket = before ?? after
        if (bracket !== undefined && !meta.lineage) {
            this.fail(`${name}( follows the hierarchy, which takes no edge types — feeds[…], fedBy[…] `
                + 'and linkedTo[…] do', t)
        }
        const set: { edgeClass?: EdgeClass; edgeTypes?: string[] } = bracket === undefined
            ? (word.links ? { edgeClass: 'links' } : {})
            : this.read(() => readEdgeSet(bracket, LINK_CLASSES), t)
        // Lineage is what a connection follows unless it says otherwise.
        const edges = (set.edgeClass === 'lineage' ? {} : set) as Pick<RelatedPredicate, 'edgeClass' | 'edgeTypes'>
        let minHops: number | undefined
        let maxHops: number | undefined
        if (dots) {                       // *M..N, *..N, *M..
            if (first) minHops = Number(first)
            if (second) maxHops = Number(second)
        } else if (first) {               // *N: exactly N
            minHops = Number(first)
            maxHops = Number(first)
        }
        let where: Predicate | undefined
        if (this.peek()?.kind === TokenKind.RParen) this.consume()
        else {
            where = this.parseExpr()
            this.expectClose(`${t.raw}…`)
        }
        const rel: RelatedPredicate = {
            kind: 'related', axis,
            ...(quantifier ? { quantifier } : {}),
            ...(minHops !== undefined && minHops > 1 ? { minHops } : {}),
            ...(maxHops !== undefined ? { maxHops } : {}),
            ...edges,
            ...(where ? { where } : {}),
        }
        const next = this.peek()
        if (next?.kind === TokenKind.Call && next.text === '.via') {
            if (!meta.lineage) this.fail(`.via(…) follows a connection — feeds, fedBy, linkedTo — not ${name}(…)`, next)
            this.consume()
            next.role = 'function'
            const condition = this.parseExpr()
            try {
                rel.edge = toEdge(condition)
            } catch (err) {
                this.fail(err instanceof Error ? err.message : String(err), next)
            }
            this.expectClose('.via(…')
        }
        this.recognized.push(t.raw)
        return rel
    }

    expectClose(what: string): void {
        if (this.peek()?.kind !== TokenKind.RParen) this.fail(`Missing ")" after ${what}`)
        this.consume()
    }

    /** ``read()``, its error pointing at ``t``. */
    read<T>(read: () => T, t: Token): T {
        try {
            return read()
        } catch (err) {
            this.fail(err instanceof Error ? err.message : String(err), t)
        }
    }

    /** `CONTAINS`, `STARTS WITH` or `ENDS WITH` at the cursor — consumed
     *  when present, nothing consumed when not. */
    tryConsumeTextOperator(): { op: 'contains' | 'startsWith' | 'endsWith'; raw: string } | null {
        const a = this.peek()
        if (a?.kind !== TokenKind.Word) return null
        const up = a.text.toUpperCase()
        if (up === 'CONTAINS') {
            this.consume()
            return { op: 'contains', raw: a.raw }
        }
        const b = this.tokens[this.pos + 1]
        if ((up === 'STARTS' || up === 'ENDS') && b?.kind === TokenKind.Word && b.text.toUpperCase() === 'WITH') {
            this.pos += 2
            return { op: up === 'STARTS' ? 'startsWith' : 'endsWith', raw: `${a.raw} ${b.raw}` }
        }
        return null
    }

    /** `key BETWEEN (lo, hi)` (what the writer emits) or `key BETWEEN lo AND hi`. */
    tryConsumeBetween(lhs: Token): Predicate | null {
        const kw = this.peek()
        if (kw?.kind !== TokenKind.Word || kw.text.toUpperCase() !== 'BETWEEN') return null
        const isValue = (x?: Token) => x?.kind === TokenKind.Word || x?.kind === TokenKind.Quoted
        const at = (i: number) => this.tokens[this.pos + i]
        let lo: Token, hi: Token, width: number
        if (at(1)?.kind === TokenKind.LParen && isValue(at(2)) && at(3)?.kind === TokenKind.Comma
            && isValue(at(4)) && at(5)?.kind === TokenKind.RParen) {
            lo = at(2); hi = at(4); width = 6
        } else if (isValue(at(1)) && at(2)?.kind === TokenKind.AndKw && isValue(at(3))) {
            lo = at(1); hi = at(3); width = 4
        } else {
            return null  // "values between" is just words
        }
        const label = [lhs.raw, ...this.tokens.slice(this.pos, this.pos + width).map((x) => x.raw)].join(' ')
        lhs.role = 'field'
        this.markTail(this.pos, this.pos + width)
        this.pos += width
        this.recognized.push(label)
        return this.consumeSuffixes({
            kind: 'property',
            key: lhs.text,
            op: 'between',
            value: [
                coerceScalar(lo.text, lo.kind === TokenKind.Quoted),
                coerceScalar(hi.text, hi.kind === TokenKind.Quoted),
            ],
        })
    }

    /** The comparisons spelled with keywords after a property key:
     *  `IS [NOT] SET|EMPTY`, `WITHIN LAST 30 DAYS` / `WITHIN LAST P30D`,
     *  `CONTAINS ALL (a, b)` and `NOT CONTAINS x` (on name, qname,
     *  description or tags: NOT of the text match). Nothing is consumed
     *  when none is there. */
    tryConsumePropertyTail(lhs: Token): Predicate | null {
        const at = (i: number): Token | undefined => this.tokens[this.pos + i]
        const word = (i: number, w: string) => {
            const x = at(i)
            return x?.kind === TokenKind.Word && x.text.toUpperCase() === w
        }
        const isValue = (x?: Token) => x?.kind === TokenKind.Word || x?.kind === TokenKind.Quoted
        const start = this.pos
        const key = lhs.text
        let pred: Predicate | null = null
        if (word(0, 'IS')) {
            const negated = at(1)?.kind === TokenKind.NotKw
            const i = negated ? 2 : 1
            if (word(i, 'SET') || word(i, 'EMPTY')) {
                const op: PropertyOp = word(i, 'SET')
                    ? (negated ? 'isNotSet' : 'isSet')
                    : (negated ? 'isNotEmpty' : 'isEmpty')
                this.pos += i + 1
                pred = { kind: 'property', key, op }
            }
        } else if (word(0, 'WITHIN') && word(1, 'LAST')) {
            const amount = at(2)
            const unit = at(3)?.kind === TokenKind.Word ? UNIT_WORDS[at(3)!.text.toLowerCase()] : undefined
            if (amount?.kind === TokenKind.Word && /^\d+$/.test(amount.text) && unit) {
                this.pos += 4
                pred = { kind: 'property', key, op: 'withinLast', value: toDuration(Number(amount.text), unit) }
            } else if (isValue(amount) && /^P/i.test(amount!.text)) {
                this.pos += 3
                pred = { kind: 'property', key, op: 'withinLast', value: amount!.text.toUpperCase() }
            }
        } else if (word(0, 'CONTAINS') && word(1, 'ALL') && at(2)?.kind === TokenKind.LParen) {
            const list = this.readParenList(this.pos + 2)
            if (list) {
                this.pos = list.end
                pred = {
                    kind: 'property', key, op: 'containsAll',
                    value: list.values.map((v, i) => coerceScalar(v, list.quoted[i])),
                }
            }
        } else if (at(0)?.kind === TokenKind.NotKw && word(1, 'CONTAINS') && isValue(at(2))) {
            const value = at(2)!.text
            this.pos += 3
            const target = lhs.kind === TokenKind.Word ? lhsToTextTarget(key) : null
            pred = target
                ? { kind: 'group', op: 'not', children: [makeTextPredicate(target, value.trim())] }
                : { kind: 'property', key, op: 'notContains', value }
        }
        if (!pred) {
            this.pos = start
            return null
        }
        lhs.role = 'field'
        this.markTail(start, this.pos)
        this.recognized.push([lhs.raw, ...this.tokens.slice(start, this.pos).map((x) => x.raw)].join(' '))
        return pred.kind === 'property' ? this.consumeSuffixes(pred) : pred
    }

    /** `AS NUMBER`, `MATCH CASE`, `INCLUDING MISSING` after a comparison. */
    consumeSuffixes(p: PropertyPredicate): PropertyPredicate {
        const at = (i: number): Token | undefined => this.tokens[this.pos + i]
        const word = (i: number, w: string) => {
            const x = at(i)
            return x?.kind === TokenKind.Word && x.text.toUpperCase() === w
        }
        let out = p
        for (;;) {
            const typeWord = word(0, 'AS') && at(1)?.kind === TokenKind.Word
                ? TYPE_WORDS[at(1)!.text.toUpperCase()] : undefined
            if (typeWord) {
                out = { ...out, valueType: typeWord }
            } else if (word(0, 'MATCH') && word(1, 'CASE')) {
                out = { ...out, caseSensitive: true }
            } else if (word(0, 'INCLUDING') && word(1, 'MISSING')) {
                out = { ...out, includeMissing: true }
            } else {
                return out
            }
            at(0)!.role = 'keyword'
            at(1)!.role = 'keyword'
            this.pos += 2
        }
    }

    /** `( a, "b", c )` starting at `cursor` (the '('): its values, which
     *  were quoted, and the index after ')'. */
    readParenList(cursor: number): { values: string[]; quoted: boolean[]; end: number } | null {
        if (this.tokens[cursor]?.kind !== TokenKind.LParen) return null
        cursor += 1
        const values: string[] = []
        const quoted: boolean[] = []
        while (cursor < this.tokens.length && this.tokens[cursor].kind !== TokenKind.RParen) {
            const inner = this.tokens[cursor]
            if (inner.kind === TokenKind.Comma) { cursor += 1; continue }
            if (inner.kind !== TokenKind.Word && inner.kind !== TokenKind.Quoted) return null
            values.push(inner.text)
            quoted.push(inner.kind === TokenKind.Quoted)
            cursor += 1
        }
        if (this.tokens[cursor]?.kind !== TokenKind.RParen) return null
        return { values, quoted, end: cursor + 1 }
    }

    tryConsumeInExpression(lhs: string, lhsQuoted = false): {
        predicate: Predicate; label: string
    } | null {
        const checkpoint = this.pos
        let cursor = checkpoint
        let negated = false
        if (this.tokens[cursor]?.kind === TokenKind.NotKw) {
            negated = true
            cursor += 1
        }
        if (this.tokens[cursor]?.kind !== TokenKind.Word) return null
        if (this.tokens[cursor].text.toUpperCase() !== 'IN') return null
        cursor += 1
        if (this.tokens[cursor]?.kind !== TokenKind.LParen) return null
        cursor += 1
        const values: string[] = []
        const quoted: boolean[] = []
        while (cursor < this.tokens.length && this.tokens[cursor].kind !== TokenKind.RParen) {
            const inner = this.tokens[cursor]
            if (inner.kind === TokenKind.Comma) { cursor += 1; continue }
            if (inner.kind !== TokenKind.Word && inner.kind !== TokenKind.Quoted) return null
            values.push(inner.text)
            quoted.push(inner.kind === TokenKind.Quoted)
            cursor += 1
        }
        if (this.tokens[cursor]?.kind !== TokenKind.RParen) return null
        cursor += 1
        const fieldName = lhsQuoted ? '' : lhs.toLowerCase()
        let predicate: Predicate | null = null
        if (fieldName === 'type' || fieldName === 'entitytype') {
            predicate = { kind: 'entityType', op: negated ? 'notIn' : 'in', values }
        } else if (fieldName === 'tag' || fieldName === 'tags') {
            predicate = { kind: 'tag', op: negated ? 'notHas' : 'hasAny', values }
        } else if (fieldName === 'descendantof') {
            // No `NOT IN` form — DescendantOfPredicate has no negate
            // field, and the BE compiler doesn't accept negated
            // descendantOf. Bail out if the user typed `NOT IN`.
            if (negated) return null
            predicate = { kind: 'descendantOf', urns: values }
        } else {
            predicate = {
                kind: 'property',
                key: lhs,
                op: negated ? 'notIn' : 'in',
                value: values.map((v, i) => coerceScalar(v, quoted[i])),
            }
        }
        const consumed = this.tokens.slice(checkpoint, cursor).map((t) => t.raw).join(' ')
        this.pos = cursor
        return {
            predicate,
            label: `${lhs} ${consumed}`,
        }
    }
}


// ---------------------------------------------------------------------------
// Predicate builders + helpers
// ---------------------------------------------------------------------------

/** A graph shape's words, read with ``_`` and ``-`` left out: the shape and
 *  the edges it counts unless brackets say otherwise. */
const SHAPE_WORDS: Record<string, [ShapeKind, EdgeClass]> = {
    noupstream: ['isRoot', 'lineage'], noupstreamlineage: ['isRoot', 'lineage'],
    nodownstream: ['isLeaf', 'lineage'], nodownstreamlineage: ['isLeaf', 'lineage'],
    nolineage: ['isOrphan', 'lineage'], orphan: ['isOrphan', 'lineage'], orphans: ['isOrphan', 'lineage'],
    hasupstream: ['hasIncoming', 'lineage'], hasdownstream: ['hasOutgoing', 'lineage'],
    noincoming: ['isRoot', 'links'], nooutgoing: ['isLeaf', 'links'], nolinks: ['isOrphan', 'links'],
    noedges: ['isOrphan', 'any'], hasincoming: ['hasIncoming', 'links'], hasoutgoing: ['hasOutgoing', 'links'],
}

/** ``noUpstream``, ``noIncoming[PRODUCES]`` and the like — or null. */
function matchBooleanToken(text: string): Predicate | null {
    const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(text)
    const shape = m ? SHAPE_WORDS[m[1].toLowerCase().replace(/[_-]/g, '')] : undefined
    if (!m || !shape) return null
    const [kind, edgeClass] = shape
    return { kind, ...(m[2] === undefined ? { edgeClass } : readEdgeSet(m[2], SHAPE_CLASSES)) }
}


/** ``prefix:value`` as a condition; ``quoted``, the value given in quotes
 *  after the colon — one value, whatever it holds. */
function matchPrefixedToken(token: string, quoted?: string): Predicate | null {
    const idx = token.indexOf(':')
    if (idx <= 0) return null
    const prefix = token.slice(0, idx).toLowerCase()
    const value = quoted ?? stripQuotes(token.slice(idx + 1))
    if (!value) return null
    const values = quoted !== undefined ? [quoted] : splitCsv(value)
    switch (prefix) {
        case 'type':
        case 'entitytype':
            return { kind: 'entityType', op: 'in', values }
        case 'tag':
        case 'tags':
            return { kind: 'tag', op: 'hasAny', values }
        case 'layer':
            return { kind: 'layer', layerAssignment: value }
        case 'hasproperty':
        case 'has': {
            // `owner*` — a name that starts with; `*owner*` — one that contains.
            const contains = value.length > 2 && value.startsWith('*') && value.endsWith('*')
            const prefix = !contains && value.length > 1 && value.endsWith('*')
            const key = contains ? value.slice(1, -1) : prefix ? value.slice(0, -1) : value
            return {
                kind: 'hasProperty', key, negate: false,
                ...(contains ? { keyMatch: 'contains' as const } : prefix ? { keyMatch: 'prefix' as const } : {}),
            }
        }
        case 'name':
            return makeTextPredicate('name', value)
        case 'qname':
        case 'qualifiedname':
            return makeTextPredicate('qualifiedName', value)
        case 'desc':
        case 'description':
            return makeTextPredicate('description', value)
        default:
            // Treat any other prefix as `property eq value` — supports
            // shortcuts like `pii_class:EMAIL` for the eq case.
            return {
                kind: 'property',
                key: prefix,
                op: 'eq',
                value: coerceScalar(value, /*wasQuoted*/ quoted !== undefined),
            }
    }
}


function makeTextPredicate(target: TextTarget, value: string): Predicate {
    return {
        kind: 'text',
        value,
        target,
        match: 'substring',
        caseSensitive: false,
        boost: 1.0,
    }
}


function lhsToTextTarget(lhs: string): TextTarget | null {
    const k = lhs.toLowerCase()
    if (k === 'name') return 'name'
    if (k === 'qname' || k === 'qualifiedname') return 'qualifiedName'
    if (k === 'desc' || k === 'description') return 'description'
    if (k === 'tags' || k === 'tag') return 'tags'
    return null
}


function stripQuotes(s: string): string {
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
        return s.slice(1, -1)
    }
    return s
}


function splitCsv(s: string): string[] {
    return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
}


function needsQuotes(s: string): boolean {
    return /\s|[",()!=<>]/.test(s) || s === ''
}


/** A string the parser would read back as something else unquoted. */
function readsAsNonText(s: string): boolean {
    return /^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false' || s === 'null'
}


function coerceScalar(value: string, wasQuoted: boolean): unknown {
    const trimmed = value.trim()
    if (trimmed === '') return ''
    if (wasQuoted) return trimmed
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    // A number with a leading zero ("007") is an identifier, and an integer
    // past 2^53 has no exact double — both stay their text.
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed)
        if (Number.isFinite(n) && (trimmed.includes('.') || Number.isSafeInteger(n))) return n
    }
    return trimmed
}


function formatScalar(v: unknown): string {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return needsQuotes(v) || readsAsNonText(v) ? `"${v}"` : v
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (Array.isArray(v)) return `(${v.map(formatScalar).join(', ')})`
    return JSON.stringify(v)
}


const PROP_OP_STR: Record<PropertyOp, string> = {
    eq: '=', neq: '!=',
    lt: '<', lte: '<=',
    gt: '>', gte: '>=',
    in: 'IN', notIn: 'NOT IN',
    contains: 'CONTAINS',
    notContains: 'NOT CONTAINS',
    containsAll: 'CONTAINS ALL',
    startsWith: 'STARTS WITH',
    endsWith: 'ENDS WITH',
    between: 'BETWEEN',
    withinLast: 'WITHIN LAST',
    isSet: 'IS SET', isNotSet: 'IS NOT SET',
    isEmpty: 'IS EMPTY', isNotEmpty: 'IS NOT EMPTY',
}


const UNIT_WORDS: Record<string, DurationUnit> = {
    h: 'hours', hour: 'hours', hours: 'hours',
    d: 'days', day: 'days', days: 'days',
    w: 'weeks', week: 'weeks', weeks: 'weeks',
    month: 'months', months: 'months',
    y: 'years', year: 'years', years: 'years',
}


const TYPE_WORDS: Record<string, ValueType> = {
    TEXT: 'string', STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', DATE: 'date',
}

const TYPE_WORD: Record<ValueType, string> = {
    string: 'TEXT', number: 'NUMBER', boolean: 'BOOLEAN', date: 'DATE',
}


/** The operator and value of a property comparison, as DSL. */
function formatComparison(c: PropertyPredicate): string {
    const op = c.op ?? 'eq'
    const arity = arityOf(op)
    if (arity === 'none') return PROP_OP_STR[op]
    if (arity === 'duration') {
        const d = parseDuration(c.value)
        return d ? `WITHIN LAST ${d.amount} ${d.unit}` : `WITHIN LAST ${formatScalar(c.value)}`
    }
    return `${PROP_OP_STR[op]} ${formatScalar(c.value)}`
}


/** The suffixes that keep a comparison's meaning through a round trip. The
 *  type is written only when the value alone would read as another one —
 *  `created = "2024-05-01"` is text equality unless it says `AS DATE`. */
function formatSuffixes(c: PropertyPredicate): string {
    const op = c.op ?? 'eq'
    const parts: string[] = []
    const type = c.valueType
    if (type && type !== 'auto' && OPERATOR_TABLE[op].types.length > 1
        && type !== predicateType({ op, value: c.value, valueKey: c.valueKey })) {
        parts.push(`AS ${TYPE_WORD[type]}`)
    }
    if (c.caseSensitive && arityOf(op) !== 'none') parts.push('MATCH CASE')
    if (c.includeMissing && isNegative(op)) parts.push('INCLUDING MISSING')
    return parts.length ? ` ${parts.join(' ')}` : ''
}


const OP_MAP: Record<string, PropertyOp> = {
    '=':  'eq',  '!=': 'neq',
    '<':  'lt',  '<=': 'lte',
    '>':  'gt',  '>=': 'gte',
}


// ---------------------------------------------------------------------------
// Tree simplification
// ---------------------------------------------------------------------------

/**
 * Flatten nested same-op groups (``AND(A, AND(B, C))`` → ``AND(A, B, C)``)
 * and unwrap single-child non-NOT groups. NOT groups stay wrapping their
 * one child so the negation is unambiguous downstream.
 */
function simplify(p: Predicate): Predicate {
    if (p.kind === 'related' && p.where) return { ...p, where: simplify(p.where) }
    if (p.kind !== 'group') return p
    const op = p.op ?? 'and'
    const children: Predicate[] = []
    for (const child of p.children) {
        const simplified = simplify(child)
        if (simplified.kind === 'group'
            && (simplified.op ?? 'and') === op
            && op !== 'not'
        ) {
            for (const grand of simplified.children) children.push(grand)
        } else {
            children.push(simplified)
        }
    }
    if (op === 'not') {
        // NOT keeps its wrapper exactly.
        return { kind: 'group', op: 'not', children }
    }
    if (children.length === 1) return children[0]
    return { kind: 'group', op, children } satisfies GroupPredicate
}
