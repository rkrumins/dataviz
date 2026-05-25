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
 *   layer:Source                   → layer = "Source"
 *   layer="Source"                 → layer = "Source"
 *   hasProperty:pii_class          → hasProperty key=pii_class
 *   has:pii_class                  → hasProperty key=pii_class
 *   rowCount > 1000                → property rowCount gt 1000
 *   rowCount=42  / rowCount:42     → property rowCount eq 42
 *   rowCount != 0                  → property rowCount neq 0
 *   noUpstream / noUpstreamLineage → isRoot edgeClass=lineage
 *   noDownstream                   → isLeaf edgeClass=lineage
 *   noLineage                      → isOrphan edgeClass=lineage
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
    EdgeClass,
} from '@/types/search'


const DEFAULT_EDGE_CLASS: EdgeClass = 'lineage'


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseResult {
    /** The parsed predicate tree, or ``null`` for empty input. */
    predicate: Predicate | null
    /** Number of structured leaves recognised (for the parse-feedback chip). */
    recognized: string[]
    /** Bareword fallback runs (for the parse-feedback chip). */
    fallbackText: string[]
    /** Hard parse error message (parens unbalanced, dangling operator, etc.). */
    error?: string
}


export function parsePredicate(input: string): ParseResult {
    const tokens = lex(input)
    const recognized: string[] = []
    const fallbackText: string[] = []
    if (tokens.length === 0) {
        return { predicate: null, recognized, fallbackText }
    }
    const p = new Parser(tokens, recognized, fallbackText)
    try {
        const pred = p.parseExpr()
        if (p.pos < tokens.length) {
            return {
                predicate: pred,
                recognized,
                fallbackText,
                error: `Unexpected token at end: ${tokens[p.pos]}`,
            }
        }
        return { predicate: simplify(pred), recognized, fallbackText }
    } catch (err) {
        return {
            predicate: null,
            recognized,
            fallbackText,
            error: err instanceof Error ? err.message : String(err),
        }
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


function formatAtom(c: Predicate): string {
    switch (c.kind) {
        case 'text': {
            const target: TextTarget = (c.target ?? 'name') as TextTarget
            // Bareword shortcut: substring/name/case-insensitive → raw word
            if (target === 'name'
                && (c.match ?? 'substring') === 'substring'
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
        case 'isRoot':       return 'noUpstream'
        case 'isLeaf':       return 'noDownstream'
        case 'isOrphan':     return 'noLineage'
        case 'hasIncoming':  return 'hasUpstream'
        case 'hasOutgoing':  return 'hasDownstream'
        case 'descendantOf': {
            // URNs always contain `:`, so quote unconditionally — the
            // prefix lexer would otherwise misread `urn:foo:bar` as a
            // `urn:` prefixed token. maxDepth (rare; UI never sets it)
            // is lossy in DSL — preserve via JSON view if needed.
            const quoted = c.urns.map((u) => `"${u}"`).join(', ')
            return `descendantOf IN (${quoted})`
        }
        default:
            return `[${(c as { kind?: string }).kind ?? 'unknown'}]`
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
}

interface Token {
    kind: TokenKind
    text: string  // canonical text (no quotes for Quoted)
    raw: string   // original source for diagnostics
}


function lex(input: string): Token[] {
    const out: Token[] = []
    let i = 0
    while (i < input.length) {
        const ch = input[i]
        if (/\s/.test(ch)) { i += 1; continue }
        if (ch === '"' || ch === "'") {
            const close = input.indexOf(ch, i + 1)
            if (close === -1) {
                out.push({ kind: TokenKind.Quoted, text: input.slice(i + 1), raw: input.slice(i) })
                i = input.length
                continue
            }
            out.push({
                kind: TokenKind.Quoted,
                text: input.slice(i + 1, close),
                raw: input.slice(i, close + 1),
            })
            i = close + 1
            continue
        }
        if (ch === '(' || ch === ')' || ch === ',') {
            out.push({
                kind: ch === '(' ? TokenKind.LParen
                    : ch === ')' ? TokenKind.RParen
                        : TokenKind.Comma,
                text: ch,
                raw: ch,
            })
            i += 1
            continue
        }
        // 2-char operators
        if ((ch === '!' || ch === '<' || ch === '>' || ch === '=') && input[i + 1] === '=') {
            const t = input.slice(i, i + 2)
            out.push({ kind: TokenKind.Op, text: t, raw: t })
            i += 2
            continue
        }
        if (ch === '=' || ch === '<' || ch === '>') {
            out.push({ kind: TokenKind.Op, text: ch, raw: ch })
            i += 1
            continue
        }
        // Standalone NOT-bang
        if (ch === '!') {
            out.push({ kind: TokenKind.NotKw, text: '!', raw: '!' })
            i += 1
            continue
        }
        // Bareword — read until whitespace, operator, paren, comma, or quote
        let j = i
        while (j < input.length) {
            const c = input[j]
            if (/\s/.test(c)) break
            if (c === '"' || c === "'") break
            if (c === '(' || c === ')' || c === ',' || c === '!') break
            if (c === '=' || c === '<' || c === '>') break
            j += 1
        }
        if (j > i) {
            const word = input.slice(i, j)
            const up = word.toUpperCase()
            // Bare keywords are reserved only when they stand alone —
            // ``AND`` ``OR`` ``NOT``. Anything containing a colon, dot,
            // or other operator-y char is treated as a token even if
            // the prefix matches.
            if ((up === 'AND' || up === '&&') && !word.includes(':')) {
                out.push({ kind: TokenKind.AndKw, text: 'AND', raw: word })
            } else if (up === 'OR' && !word.includes(':')) {
                out.push({ kind: TokenKind.OrKw, text: 'OR', raw: word })
            } else if (up === 'NOT' && !word.includes(':')) {
                out.push({ kind: TokenKind.NotKw, text: 'NOT', raw: word })
            } else {
                out.push({ kind: TokenKind.Word, text: word, raw: word })
            }
            i = j
        } else {
            i += 1
        }
    }
    return out
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
    ) {}

    peek(): Token | null {
        return this.tokens[this.pos] ?? null
    }

    consume(): Token {
        return this.tokens[this.pos++]
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
        if (!t) throw new Error('Unexpected end of input')
        if (t.kind === TokenKind.LParen) {
            this.consume()
            const inner = this.parseExpr()
            const closing = this.peek()
            if (!closing || closing.kind !== TokenKind.RParen) {
                throw new Error('Missing closing parenthesis')
            }
            this.consume()
            return inner
        }
        // Predicate token — may consume up to 3 tokens (e.g. `name CONTAINS x`).
        return this.parsePredicateToken()
    }

    parsePredicateToken(): Predicate {
        const t = this.consume()

        // 1) boolean-shaped bareword (noUpstream, etc.)
        if (t.kind === TokenKind.Word) {
            const bool = matchBooleanToken(t.text)
            if (bool) {
                this.recognized.push(t.text)
                return bool
            }
        }

        // 2) `lhs CONTAINS rhs` — three tokens
        if (t.kind === TokenKind.Word) {
            const containsT = this.peek()
            if (containsT?.kind === TokenKind.Word && containsT.text.toUpperCase() === 'CONTAINS') {
                const target = lhsToTextTarget(t.text)
                if (target) {
                    this.consume()  // CONTAINS
                    const rhs = this.consume()
                    const value = (rhs.kind === TokenKind.Quoted ? rhs.text : rhs.text).trim()
                    if (value) {
                        this.recognized.push(`${t.text} CONTAINS ${rhs.raw}`)
                        return makeTextPredicate(target, value)
                    }
                }
            }
        }

        // 3) `type [NOT] IN ( a, b, c )`
        if (t.kind === TokenKind.Word) {
            const inResult = this.tryConsumeInExpression(t.text)
            if (inResult) {
                this.recognized.push(inResult.label)
                return inResult.predicate
            }
        }

        // 4) `key OP value` (eq / neq / lt / lte / gt / gte)
        if (t.kind === TokenKind.Word) {
            const opT = this.peek()
            if (opT?.kind === TokenKind.Op) {
                const propOp = OP_MAP[opT.text]
                if (propOp) {
                    this.consume()  // op
                    const valT = this.consume()
                    const rawValue = valT.kind === TokenKind.Quoted ? valT.text : valT.text
                    this.recognized.push(`${t.text} ${opT.text} ${valT.raw}`)
                    // `layer = "X"` is a layer predicate
                    if (t.text.toLowerCase() === 'layer' && propOp === 'eq') {
                        return { kind: 'layer', layerAssignment: rawValue }
                    }
                    return {
                        kind: 'property',
                        key: t.text,
                        op: propOp,
                        value: coerceScalar(rawValue, valT.kind === TokenKind.Quoted),
                    }
                }
            }
        }

        // 5) `prefix:value` (single token containing a colon)
        if (t.kind === TokenKind.Word && t.text.includes(':')) {
            const prefixed = matchPrefixedToken(t.text)
            if (prefixed) {
                this.recognized.push(t.text)
                return prefixed
            }
        }

        // 6) Bareword / quoted → substring text predicate against name
        const value = (t.kind === TokenKind.Quoted ? t.text : t.text).trim()
        if (!value) {
            // Operator-only token with no atom — fail.
            throw new Error(`Unexpected token: ${t.raw}`)
        }
        this.fallbackText.push(value)
        return makeTextPredicate('name', value)
    }

    tryConsumeInExpression(lhs: string): {
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
        while (cursor < this.tokens.length && this.tokens[cursor].kind !== TokenKind.RParen) {
            const inner = this.tokens[cursor]
            if (inner.kind === TokenKind.Comma) { cursor += 1; continue }
            if (inner.kind !== TokenKind.Word && inner.kind !== TokenKind.Quoted) return null
            values.push(inner.text)
            cursor += 1
        }
        if (this.tokens[cursor]?.kind !== TokenKind.RParen) return null
        cursor += 1
        const fieldName = lhs.toLowerCase()
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
            return null
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

function matchBooleanToken(text: string): Predicate | null {
    const norm = text.toLowerCase().replace(/[_-]/g, '')
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
                value: coerceScalar(value, /*wasQuoted*/ false),
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
    return /\s|[",()!]/.test(s)
}


function coerceScalar(value: string, wasQuoted: boolean): unknown {
    const trimmed = value.trim()
    if (trimmed === '') return ''
    if (wasQuoted) return trimmed
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
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
