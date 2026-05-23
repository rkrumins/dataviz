/**
 * predicateDsl — a tiny human-friendly query language for the AskBar.
 *
 * Power users type filter expressions directly in the search box;
 * the parser turns them into a tree of predicates that ANDs into the
 * draft. The stringifier rebuilds the same text from a predicate so
 * the box and the chip strip stay in sync: toggle a chip → box text
 * updates; type a token → chip lights up.
 *
 * Supported tokens (loose, whitespace-separated; AND is optional):
 *
 *   bareword                       → text contains "bareword" in name
 *   "quoted phrase"                → text contains "quoted phrase" in name
 *   name CONTAINS "foo"            → text contains "foo" in name
 *   name CONTAINS foo              → text contains "foo" in name
 *   qname:foo  / qualifiedName:foo → text contains "foo" in qualifiedName
 *   description:foo / desc:foo     → text contains "foo" in description
 *   type:dataset                   → entityType IN [dataset]
 *   type:dataset,schemaField       → entityType IN [dataset, schemaField]
 *   type IN (dataset, schemaField) → entityType IN [dataset, schemaField]
 *   tag:PII                        → tag hasAny [PII]
 *   tag:PII,GDPR                   → tag hasAny [PII, GDPR]
 *   layer:Source                   → layer = "Source"
 *   layer="Source"                 → layer = "Source"
 *   hasProperty:pii_class          → hasProperty key=pii_class
 *   has:pii_class                  → hasProperty key=pii_class
 *   rowCount > 1000                → property rowCount gt 1000
 *   rowCount=42  / rowCount:42     → property rowCount eq 42
 *   rowCount != 0                  → property rowCount neq 0
 *   noUpstream / noUpstreamLineage → isRoot edgeClass=lineage
 *   noDownstream / noDownstreamLineage → isLeaf edgeClass=lineage
 *   noLineage                      → isOrphan edgeClass=lineage
 *
 * Conjunctions: ``AND``, ``&&``, ``,``, or plain whitespace.
 * OR / NOT / paths: NOT supported here — open the Advanced builder.
 *
 * The parser is intentionally lenient: tokens it can't recognise fall
 * back to a substring text match against name. That means a user can
 * always type a plain word and get a sensible search — the DSL only
 * "activates" when they reach for specific operators.
 */
import type { Predicate, TextTarget, PropertyOp, EdgeClass } from '@/types/search'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


// ---------------------------------------------------------------------------
// PARSE
// ---------------------------------------------------------------------------

export interface ParseResult {
    /** Conjunction of the parsed conditions. Null when the input was
     *  effectively empty after trimming. */
    predicate: Predicate | null
    /** Tokens the parser recognised, in order. Useful for UI feedback. */
    recognized: string[]
    /** Raw fragments that fell through as substring text search. */
    fallbackText: string[]
}


export function parsePredicate(input: string): ParseResult {
    const conditions: Predicate[] = []
    const recognized: string[] = []
    const fallbackText: string[] = []

    // Lex into tokens (respects quoted strings) so we can match against
    // structured patterns one token at a time.
    const tokens = lex(input)
    let i = 0
    while (i < tokens.length) {
        const tok = tokens[i]

        // Conjunctions are no-ops — implicit AND already.
        if (isConjunctionToken(tok)) { i += 1; continue }

        // 1) Boolean-shaped tokens (no params).
        const boolPred = matchBooleanToken(tok)
        if (boolPred) {
            conditions.push(boolPred)
            recognized.push(tok)
            i += 1; continue
        }

        // 2) `name CONTAINS "value"` / `name CONTAINS value`
        const containsRes = matchContainsExpression(tokens, i)
        if (containsRes) {
            conditions.push(containsRes.predicate)
            recognized.push(containsRes.tokens.join(' '))
            i += containsRes.consumed; continue
        }

        // 3) `type IN ( a, b )`  → multi-value
        const inRes = matchInExpression(tokens, i)
        if (inRes) {
            conditions.push(inRes.predicate)
            recognized.push(inRes.tokens.join(' '))
            i += inRes.consumed; continue
        }

        // 4) `key OP value` (op = one of = != < <= > >=)
        const opRes = matchOpExpression(tokens, i)
        if (opRes) {
            conditions.push(opRes.predicate)
            recognized.push(opRes.tokens.join(' '))
            i += opRes.consumed; continue
        }

        // 5) `prefix:value`  (type:, tag:, layer:, hasProperty:, has:, qname:, desc:, key:)
        const prefixed = matchPrefixedToken(tok)
        if (prefixed) {
            conditions.push(prefixed)
            recognized.push(tok)
            i += 1; continue
        }

        // 6) Fallback — accumulate unrecognised tokens; they'll combine
        //    into a SINGLE substring text predicate so a multi-word
        //    casual search like ``customer orders`` reads as one phrase,
        //    not two competing predicates that the chip composer would
        //    upsert-collapse to whichever came last.
        const txt = stripQuotes(tok).trim()
        if (txt) fallbackText.push(txt)
        i += 1
    }

    if (fallbackText.length > 0) {
        conditions.push(makeTextPredicate('name', fallbackText.join(' ')))
    }

    if (conditions.length === 0) {
        return { predicate: null, recognized, fallbackText }
    }
    if (conditions.length === 1) {
        return { predicate: conditions[0], recognized, fallbackText }
    }
    return {
        predicate: { kind: 'group', op: 'and', children: conditions },
        recognized,
        fallbackText,
    }
}


// ---------------------------------------------------------------------------
// STRINGIFY
// ---------------------------------------------------------------------------

/**
 * Round-trip a predicate back to DSL text. Always emits the canonical
 * form (so e.g. ``customer`` → after a run becomes ``name CONTAINS
 * "customer"``). Non-AND roots (OR / NOT) emit a placeholder the user
 * sees, but can't edit by typing — they'll need Advanced.
 */
export function stringifyPredicate(p: Predicate | null): string {
    if (!p) return ''
    if (p.kind === 'group' && p.op === 'and') {
        return p.children.map(stringifyOne).filter(Boolean).join(' AND ')
    }
    return stringifyOne(p)
}


function stringifyOne(c: Predicate): string {
    switch (c.kind) {
        case 'text': {
            const target: TextTarget = (c.target ?? 'name') as TextTarget
            // Bareword shortcut: a substring search against `name`
            // round-trips as the raw word(s) — so typing ``customer``
            // stays as ``customer`` in the box, not ``name CONTAINS
            // "customer"``. Only escalate to the verbose form when the
            // value has characters that would be re-parsed as syntax
            // (whitespace handled by quoting; operators by escaping).
            if (target === 'name'
                && c.match === 'substring'
                && !c.caseSensitive
            ) {
                if (!needsQuotes(c.value)) return c.value
                return `"${c.value}"`
            }
            const value = needsQuotes(c.value) ? `"${c.value}"` : c.value
            if (target === 'name') return `name CONTAINS ${value}`
            if (target === 'qualifiedName') return `qname:${value}`
            if (target === 'description') return `description:${value}`
            if (target === 'tags') return `tag:${value}`
            if (target === 'any') return value
            return `${target}:${value}`
        }
        case 'entityType': {
            const verb = c.op === 'notIn' ? 'type NOT IN' : 'type:'
            if (verb.endsWith(':')) return `type:${c.values.join(',')}`
            return `${verb} (${c.values.join(', ')})`
        }
        case 'tag': {
            // Stringify both `has` and `hasAny` as `tag:` for brevity.
            // `hasAll` becomes `tag ALL` for distinguishability.
            const op = c.op
            if (op === 'hasAll') return `tag ALL (${c.values.join(', ')})`
            if (op === 'notHas') return `tag NOT IN (${c.values.join(', ')})`
            return `tag:${c.values.join(',')}`
        }
        case 'layer':
            return needsQuotes(c.layerAssignment)
                ? `layer="${c.layerAssignment}"`
                : `layer:${c.layerAssignment}`
        case 'hasProperty':
            return c.negate ? `not has:${c.key}` : `hasProperty:${c.key}`
        case 'property': {
            const op = c.op ?? 'eq'
            const opStr = PROP_OP_STR[op]
            const val = formatScalar(c.value)
            return `${c.key} ${opStr} ${val}`
        }
        case 'isRoot': return 'noUpstream'
        case 'isLeaf': return 'noDownstream'
        case 'isOrphan': return 'noLineage'
        case 'hasIncoming': return 'hasUpstream'
        case 'hasOutgoing': return 'hasDownstream'
        case 'group': {
            const op = (c.op ?? 'and').toUpperCase()
            if (op === 'AND') {
                return c.children.map(stringifyOne).filter(Boolean).join(' AND ')
            }
            // OR / NOT groups don't round-trip yet — flag them so the
            // user knows the DSL doesn't fully express their query.
            return `[${op} group · open Advanced to edit]`
        }
        default:
            return `[${(c as { kind?: string }).kind ?? 'unknown'}]`
    }
}


// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/**
 * Split the input into tokens. Whitespace separates; quoted strings
 * preserve their interior (and keep the quotes so the parser knows
 * "this was quoted"). Operators ``=`` ``!=`` ``<`` ``>`` ``<=`` ``>=``
 * become their own tokens whether or not they're space-separated.
 */
function lex(input: string): string[] {
    const out: string[] = []
    let i = 0
    while (i < input.length) {
        const ch = input[i]
        if (/\s/.test(ch)) { i += 1; continue }
        // Quoted string
        if (ch === '"' || ch === "'") {
            const close = input.indexOf(ch, i + 1)
            if (close === -1) {
                out.push(input.slice(i))
                break
            }
            out.push(input.slice(i, close + 1))
            i = close + 1
            continue
        }
        // 2-char operators
        if ((ch === '!' || ch === '<' || ch === '>' || ch === '=') && input[i + 1] === '=') {
            out.push(input.slice(i, i + 2))
            i += 2
            continue
        }
        // Single-char operators
        if (ch === '=' || ch === '<' || ch === '>' || ch === '(' || ch === ')' || ch === ',') {
            out.push(ch)
            i += 1
            continue
        }
        // Bareword — read until whitespace, operator, or quote
        let j = i
        while (j < input.length) {
            const c = input[j]
            if (/\s/.test(c)) break
            if (c === '"' || c === "'") break
            if (c === '=' || c === '<' || c === '>' || c === '(' || c === ')' || c === ',') break
            if ((c === '!' || c === '<' || c === '>' || c === '=') && input[j + 1] === '=') break
            j += 1
        }
        if (j > i) {
            out.push(input.slice(i, j))
            i = j
        } else {
            i += 1
        }
    }
    return out
}


// ---------------------------------------------------------------------------
// Token matchers
// ---------------------------------------------------------------------------

function isConjunctionToken(t: string): boolean {
    const u = t.toUpperCase()
    return u === 'AND' || u === '&&' || u === ','
}


function matchBooleanToken(t: string): Predicate | null {
    const norm = t.toLowerCase().replace(/[_-]/g, '')
    if (norm === 'noupstream' || norm === 'noupstreamlineage') {
        return { kind: 'isRoot', edgeClass: DEFAULT_EDGE_CLASS }
    }
    if (norm === 'nodownstream' || norm === 'nodownstreamlineage') {
        return { kind: 'isLeaf', edgeClass: DEFAULT_EDGE_CLASS }
    }
    if (norm === 'nolineage' || norm === 'orphan' || norm === 'orphans') {
        return { kind: 'isOrphan', edgeClass: DEFAULT_EDGE_CLASS }
    }
    if (norm === 'hasupstream') {
        return { kind: 'hasIncoming', edgeClass: DEFAULT_EDGE_CLASS }
    }
    if (norm === 'hasdownstream') {
        return { kind: 'hasOutgoing', edgeClass: DEFAULT_EDGE_CLASS }
    }
    return null
}


/** Matches `name CONTAINS "value"` or `name CONTAINS value`. */
function matchContainsExpression(tokens: string[], start: number): {
    predicate: Predicate; consumed: number; tokens: string[]
} | null {
    if (start + 2 >= tokens.length) return null
    const lhs = tokens[start]
    const op = tokens[start + 1]
    const rhs = tokens[start + 2]
    if (op.toUpperCase() !== 'CONTAINS') return null
    const target = lhsToTextTarget(lhs)
    if (!target) return null
    const value = stripQuotes(rhs).trim()
    if (!value) return null
    return {
        predicate: makeTextPredicate(target, value),
        consumed: 3,
        tokens: [lhs, op, rhs],
    }
}


/** Matches `type IN (a, b)` / `type NOT IN (a, b)`. */
function matchInExpression(tokens: string[], start: number): {
    predicate: Predicate; consumed: number; tokens: string[]
} | null {
    const lhs = tokens[start]
    let cursor = start + 1
    let negated = false
    if (tokens[cursor]?.toUpperCase() === 'NOT') { negated = true; cursor += 1 }
    if (tokens[cursor]?.toUpperCase() !== 'IN') return null
    cursor += 1
    if (tokens[cursor] !== '(') return null
    cursor += 1
    const values: string[] = []
    while (cursor < tokens.length && tokens[cursor] !== ')') {
        if (tokens[cursor] === ',') { cursor += 1; continue }
        values.push(stripQuotes(tokens[cursor]))
        cursor += 1
    }
    if (tokens[cursor] !== ')') return null
    cursor += 1

    const fieldName = lhs.toLowerCase()
    if (fieldName === 'type' || fieldName === 'entitytype') {
        return {
            predicate: {
                kind: 'entityType',
                op: negated ? 'notIn' : 'in',
                values,
            },
            consumed: cursor - start,
            tokens: tokens.slice(start, cursor),
        }
    }
    if (fieldName === 'tag' || fieldName === 'tags') {
        return {
            predicate: {
                kind: 'tag',
                op: negated ? 'notHas' : 'hasAny',
                values,
            },
            consumed: cursor - start,
            tokens: tokens.slice(start, cursor),
        }
    }
    return null
}


/** Matches `key OP value` where OP is one of = != < <= > >=. */
function matchOpExpression(tokens: string[], start: number): {
    predicate: Predicate; consumed: number; tokens: string[]
} | null {
    if (start + 2 >= tokens.length) return null
    const lhs = tokens[start]
    const op = tokens[start + 1]
    const rhs = tokens[start + 2]
    const opMap: Record<string, PropertyOp> = {
        '=': 'eq', '!=': 'neq',
        '<': 'lt', '<=': 'lte',
        '>': 'gt', '>=': 'gte',
    }
    const propOp = opMap[op]
    if (!propOp) return null

    // `layer = "Source"` is a layer predicate (specialised on `layer`
    // key) — easier to compose with the chip strip if we emit a
    // LayerPredicate instead of a property=value.
    if (lhs.toLowerCase() === 'layer' && propOp === 'eq') {
        const value = stripQuotes(rhs)
        return {
            predicate: { kind: 'layer', layerAssignment: value },
            consumed: 3,
            tokens: [lhs, op, rhs],
        }
    }

    const value = coerceScalar(rhs)
    return {
        predicate: {
            kind: 'property',
            key: lhs,
            op: propOp,
            value,
        },
        consumed: 3,
        tokens: [lhs, op, rhs],
    }
}


/** Matches `prefix:value` (single token containing a colon). */
function matchPrefixedToken(token: string): Predicate | null {
    const idx = token.indexOf(':')
    if (idx <= 0) return null
    const prefix = token.slice(0, idx).toLowerCase()
    const raw = token.slice(idx + 1)
    const value = stripQuotes(raw)
    if (!value) return null
    switch (prefix) {
        case 'type':
        case 'entitytype':
            return { kind: 'entityType', op: 'in', values: splitCsv(value) }
        case 'tag':
        case 'tags':
            return { kind: 'tag', op: 'hasAny', values: splitCsv(value) }
        case 'layer':
            return { kind: 'layer', layerAssignment: value }
        case 'hasproperty':
        case 'has':
            return { kind: 'hasProperty', key: value, negate: false }
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
                value: coerceScalar(value),
            }
    }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    return /\s|[",()]/.test(s)
}


function coerceScalar(s: string): unknown {
    const trimmed = stripQuotes(s).trim()
    if (trimmed === '') return ''
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    // Numeric coercion only when the source wasn't quoted.
    if (s[0] !== '"' && s[0] !== "'" && /^-?\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed)
        if (!Number.isNaN(n)) return n
    }
    return trimmed
}


function formatScalar(v: unknown): string {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return needsQuotes(v) ? `"${v}"` : v
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
    startsWith: 'STARTS WITH',
    endsWith: 'ENDS WITH',
    between: 'BETWEEN',
}
