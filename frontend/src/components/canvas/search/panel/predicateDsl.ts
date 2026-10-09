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
    EdgeClass,
} from '@/types/search'
import { OPERATOR_TABLE } from '@/types/generated/searchOperators'

import { arityOf, autoTypeOf, isNegative, predicateType } from '../typed/operators'
import { type DurationUnit, parseDuration, toDuration } from '../typed/valueCodec'
import type { ValueType } from '../typed/valueTypes'


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
        case 'isRoot': case 'isLeaf': case 'isOrphan': case 'hasIncoming': case 'hasOutgoing':
            return stable([p.kind, p.edgeClass ?? DEFAULT_EDGE_CLASS, p.edgeTypes ?? null])
        case 'property': {
            const op = p.op ?? 'eq'
            const arity = arityOf(op)
            return stable(['property', p.key, op,
                arity === 'none' ? null : arity === 'duration' ? String(p.value).toUpperCase() : p.value,
                arity === 'none' || OPERATOR_TABLE[op].types.length === 1 ? null : predicateType(p),
                arity !== 'none' && !!p.caseSensitive, isNegative(op) && !!p.includeMissing])
        }
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


/** JSON with keys in order and undefined fields dropped. */
function stable(v: unknown): string {
    return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
}


/** The one way the words write a condition that isn't text, or null. */
function spelling(c: Predicate): string | null {
    switch (c.kind) {
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
        case 'hasProperty': {
            const name = c.keyMatch === 'prefix' ? `${c.key}*`
                : c.keyMatch === 'contains' ? `*${c.key}*` : c.key
            return c.negate ? `not has:${name}` : `hasProperty:${name}`
        }
        case 'property': {
            const key = needsQuotes(c.key) ? `"${c.key}"` : c.key
            return `${key} ${formatComparison(c)}${formatSuffixes(c)}`
        }
        case 'isRoot':       return 'noUpstream'
        case 'isLeaf':       return 'noDownstream'
        case 'isOrphan':     return 'noLineage'
        case 'hasIncoming':  return 'hasUpstream'
        case 'hasOutgoing':  return 'hasDownstream'
        case 'descendantOf': {
            // URNs always contain `:`, so quote unconditionally — the
            // prefix lexer would otherwise misread `urn:foo:bar` as a
            // `urn:` prefixed token. One with a maxDepth doesn't read back
            // from this, so it is written as JSON (``formatAtom``).
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
        if (ch === '{') {
            // A condition as JSON: to its matching brace, strings and all.
            const end = jsonEnd(input, i)
            const text = input.slice(i, end)
            out.push({ kind: TokenKind.Json, text, raw: text })
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
                throw new Error(`Not a condition: ${t.raw}`)
            }
            this.recognized.push(kind)
            return value as Predicate
        }

        // 1) boolean-shaped bareword (noUpstream, etc.)
        if (t.kind === TokenKind.Word) {
            const bool = matchBooleanToken(t.text)
            if (bool) {
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
            const inResult = this.tryConsumeInExpression(t.text, t.kind === TokenKind.Quoted)
            if (inResult) {
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
                    const valT = this.consume()
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
                this.pos += 2
            } else if (word(0, 'MATCH') && word(1, 'CASE')) {
                out = { ...out, caseSensitive: true }
                this.pos += 2
            } else if (word(0, 'INCLUDING') && word(1, 'MISSING')) {
                out = { ...out, includeMissing: true }
                this.pos += 2
            } else {
                return out
            }
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
        && type !== autoTypeOf(op, c.value)) {
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
