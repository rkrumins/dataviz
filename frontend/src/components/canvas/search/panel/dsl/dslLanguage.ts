/**
 * dslLanguage — the query language in a code editor, all of it read off the
 * one parser that also builds the query (``parsePredicate``):
 *
 *   highlighting   each token coloured for the part the parser read it as
 *   the underline  the parser's error, at the place it points to
 *   completion     what fits where the cursor is — entity types after
 *                  ``type:``, every operator after a property's name, its
 *                  values after ``owner =`` and inside ``tier IN (``,
 *                  durations after ``WITHIN LAST``, the suffixes a
 *                  comparison takes, edge fields inside ``.via(``, entities
 *                  by name after ``@"``, edge types inside ``outgoing[`` and
 *                  ``to[``, a connection's far end after ``from(…)``, and
 *                  words and relationships to start a condition with
 *   warnings       an edge type this data source doesn't have
 *   selecting      a whole condition: from the word that starts it, or
 *                  out from the cursor, a group at a time
 *
 * Every list the completion offers is the view's own (discovery, or a
 * server search for names and values), so nothing is guessed or loaded whole.
 */
import {
    type Completion,
    type CompletionContext,
    type CompletionResult,
    type CompletionSource,
    snippetCompletion,
    startCompletion,
} from '@codemirror/autocomplete'
import { type Diagnostic, linter } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'

import { OPERATOR_TABLE, type PropertyOperator } from '@/types/generated/searchOperators'
import type { NodeRef, Predicate, PropertyPredicate } from '@/types/search'

import type { RoleRange } from '../../editor/codeMirrorBase'
import { arityOf, isNegative, operatorLabel, predicateType } from '../../typed/operators'
import type { ValueType } from '../../typed/valueTypes'
import type { NamedEntity } from '../entityNames'
import { type DslRole, type DslSpan, type DslToken, parsePredicate, PROP_OP_STR } from '../predicateDsl'
import { formatNamePath } from '../relations'
import { EDGE_SET_OPTIONS } from '../vocabulary/edgeWords'


/** What the editor completes from — the view's vocabulary. */
export interface DslVocabulary {
    entityTypes: readonly string[]
    tags: readonly string[]
    /** Layer values (``layer:`` takes a layer's value). */
    layers: readonly string[]
    propertyKeys: readonly string[]
    edgeKeys: readonly string[]
    /** The edge types ``[…]`` names: what each is and connects, and whether
     *  it is the hierarchy's — which a connection never walks. */
    edgeTypes?: readonly { id: string; detail?: string; containment?: boolean }[]
    /** A property's common values, narrowed by the text typed. */
    suggestValues?: (key: string, q: string) => Promise<{ values?: { value?: unknown }[] } | null>
    /** Entities by name, and the shortest path that names one alone. */
    names?: {
        search: (word: string, signal: AbortSignal) => Promise<NamedEntity[]>
        pathFor: (entity: NamedEntity) => Promise<NodeRef>
    }
}


// ---------------------------------------------------------------------------
// Highlighting and the underline
// ---------------------------------------------------------------------------

/** The parser's tokens as ranges to colour; ``key:value`` in two parts. */
export function dslRanges(text: string): RoleRange[] {
    const out: RoleRange[] = []
    for (const t of parsePredicate(text).tokens) {
        const colon = t.role === 'prefixed' ? t.text.indexOf(':') : -1
        if (colon > 0) {
            out.push({ from: t.from, to: t.from + colon + 1, role: 'prefix' })
            out.push({ from: t.from + colon + 1, to: t.to, role: 'value' })
        } else {
            out.push({ from: t.from, to: t.to, role: t.role })
        }
    }
    return out
}


/** The parse error as a diagnostic: underlined where it points — the last
 *  character when it points past the end ("it ends too soon"). A query
 *  that reads gets a warning on each edge type not among ``edgeTypes``,
 *  once they are known. */
export function dslDiagnostics(text: string, edgeTypes?: readonly { id: string }[]): Diagnostic[] {
    const result = parsePredicate(text)
    if (!result.error) return edgeTypes?.length ? unknownEdgeTypes(result.tokens, edgeTypes) : []
    let from = Math.min(result.errorAt?.from ?? 0, text.length)
    let to = Math.min(result.errorAt?.to ?? text.length, text.length)
    if (to <= from) {
        from = Math.max(0, text.length - 1)
        to = text.length
    }
    return [{ from, to, severity: 'error', message: result.error }]
}

/** The words ``[…]`` reads as a class of edges, not an edge type. */
const EDGE_CLASS_WORDS = new Set(['lineage', 'links', 'any', 'containment'])

/** A warning on each name in brackets that isn't an edge type here. */
function unknownEdgeTypes(tokens: readonly DslToken[], edgeTypes: readonly { id: string }[]): Diagnostic[] {
    const known = new Set(edgeTypes.map((t) => t.id.toUpperCase()))
    const out: Diagnostic[] = []
    for (const t of tokens) {
        if (t.role !== 'function' && t.role !== 'keyword') continue
        const open = t.text.indexOf('[')
        const close = t.text.indexOf(']', open)
        if (open < 0 || close < 0) continue
        let at = t.from + open + 1
        for (const part of t.text.slice(open + 1, close).split(',')) {
            const raw = part.trim()
            // In quotes, a name is an edge type even when it reads as a class.
            const isQuoted = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
            const name = isQuoted ? raw.slice(1, -1) : raw
            if (name && (isQuoted || !EDGE_CLASS_WORDS.has(name.toLowerCase())) && !known.has(name.toUpperCase())) {
                const from = at + part.indexOf(raw) + (isQuoted ? 1 : 0)
                out.push({ from, to: from + name.length, severity: 'warning',
                           message: `Edge type ${name} isn't in this data source` })
            }
            at += part.length + 1
        }
    }
    return out
}

/** The underline and the warnings, ``vocabulary()`` read at each pass. */
export function dslLint(vocabulary: () => DslVocabulary) {
    return linter((view) => dslDiagnostics(view.state.doc.toString(), vocabulary().edgeTypes), { delay: 200 })
}


// ---------------------------------------------------------------------------
// Selecting a condition
// ---------------------------------------------------------------------------

/** The parts a condition starts with (or, for AND/OR, joins with). */
const HEAD_ROLES: ReadonlySet<DslRole> = new Set(['keyword', 'function', 'field'])

/** The smallest of ``spans`` holding ``from``–``to`` and wider than it,
 *  or as wide when ``orEqual``. */
function smallestAround(spans: readonly DslSpan[], from: number, to: number, orEqual = false): DslSpan | null {
    let best: DslSpan | null = null
    for (const s of spans) {
        const wider = s.to - s.from > to - from
        if (s.from > from || s.to < to || !(wider || orEqual)) continue
        if (!best || s.to - s.from < best.to - best.from) best = s
    }
    return best
}

/** The whole condition a double-click at ``pos`` selects: when ``pos`` is
 *  on the word that starts it — ``tag`` in ``tag:PII``, ``outgoing[…](``,
 *  ``NOT``, a property's name — or on an AND/OR, which takes in its group.
 *  ``null`` on any other word, which selects as a word does. */
export function conditionAtHead(text: string, pos: number): DslSpan | null {
    const { tokens, spans } = parsePredicate(text)
    const t = tokens.find((x) => x.from <= pos && pos < x.to)
        ?? tokens.find((x) => x.to === pos)
    if (!t) return null
    const colon = t.role === 'prefixed' ? t.text.indexOf(':') : -1
    const onPrefix = colon > 0 && pos <= t.from + colon
    if (!HEAD_ROLES.has(t.role) && !onPrefix) return null
    return smallestAround(spans, t.from, t.to, true)
}

/** The next condition or group out from ``from``–``to``; ``null`` when
 *  none is wider. */
export function widerCondition(text: string, from: number, to: number): DslSpan | null {
    return smallestAround(parsePredicate(text).spans, from, to)
}


// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** What the cursor is in the middle of. ``from``: where the text being
 *  completed starts. */
export type DslCompletionContext =
    | { kind: 'name'; from: number; text: string }
    | { kind: 'prefixValue'; prefix: 'type' | 'tag' | 'layer' | 'has'; from: number; text: string;
        taken: string[] }
    /** ``taken``: inside ``IN (…)``, the values already listed. */
    | { kind: 'value'; key: string; from: number; text: string; quoted: boolean; taken?: string[] }
    | { kind: 'operator'; key: string; quoted: boolean; field: ComparedField; from: number; text: string }
    | { kind: 'duration'; from: number; text: string }
    | { kind: 'via'; from: number; text: string }
    | { kind: 'edgeKey'; from: number; text: string }
    | { kind: 'edgeType'; from: number; text: string; taken: string[]; connection: boolean }
    | { kind: 'keyRef'; from: number; text: string }
    | { kind: 'connectionEnd'; from: number; text: string }
    | { kind: 'term'; from: number; text: string }

/** What a name before an operator is: a property, one of the text fields
 *  (``name``, ``description``…), ``type`` or ``layer`` — each takes its own
 *  operators. */
export type ComparedField = 'property' | 'text' | 'type' | 'layer'

const PREFIXES: Record<string, 'type' | 'tag' | 'layer' | 'has'> = {
    type: 'type', entitytype: 'type', tag: 'tag', tags: 'tag', layer: 'layer',
    has: 'has', hasproperty: 'has',
}

/** A comparison's key and operator just before the cursor: ``owner = ``,
 *  ``"Asset Owner" != "``, ``name CONTAINS ``, ``owner NOT CONTAINS ``. */
const COMPARISON = /(?:^|[\s(!])("[^"]+"|[A-Za-z_][\w.-]*)\s*(=|!=|<=|>=|<|>|\bNOT\s+CONTAINS\b|\bCONTAINS\b|\bSTARTS\s+WITH\b|\bENDS\s+WITH\b)\s*(["']?)([^\s"'()]*)$/i

/** Inside a list not yet closed: ``tier IN (gold, s``, ``NOT IN (``,
 *  ``CONTAINS ALL (``. */
const VALUE_LIST = /(?:^|[\s(!])("[^"]+"|[A-Za-z_][\w.-]*)\s+(?:NOT\s+IN|IN|CONTAINS\s+ALL)\s*\(([^()]*)$/i

/** After ``WITHIN LAST``: how long — an amount, then its unit begun. */
const DURATION = /(?:^|[\s(!])(?:"[^"]+"|[A-Za-z_][\w.-]*)\s+WITHIN\s+LAST\s+(\w*(?:\s+[A-Za-z]*)?)$/i


/** ``keyField``: what a name before the cursor is, if it can start a
 *  comparison — the vocabulary knows; without it, names are words. */
export function completionContextAt(
    doc: string, pos: number,
    keyField?: (key: string, quoted: boolean) => ComparedField | null,
): DslCompletionContext {
    const before = doc.slice(0, pos)
    // Inside @"… not yet closed: an entity, by name.
    const ref = /@(["'])([^"']*)$/.exec(before)
    if (ref) return { kind: 'name', from: pos - ref[2].length, text: ref[2] }

    // After a comparison, inside {… not yet closed: another property.
    const keyRef = /(?:=|<|>)\s*\{([^{}":]*)$/.exec(before)
    if (keyRef) return { kind: 'keyRef', from: pos - keyRef[1].length, text: keyRef[1] }

    // Inside outgoing[… not yet closed: edge types — a relationship's never
    // the hierarchy's. A connection's end (to[, or linkedTo[ right after
    // from(…)) takes any edges, as a count does.
    const bracket = /(?:^|[\s(!])([A-Za-z_-]+)(?:\*[\d.]*)?\[([^\]]*)$/.exec(before)
    const edgeWord = bracket?.[1].toLowerCase().replace(/[_-]/g, '') ?? ''
    if (bracket && (CONNECTION_WORDS.has(edgeWord) || COUNTING_WORDS.has(edgeWord) || edgeWord === 'to')) {
        const names = bracket[2].split(',')
        const text = (names.pop() ?? '').trimStart()
        const head = before.slice(0, bracket.index + bracket[0].indexOf(bracket[1]))
        return { kind: 'edgeType', from: pos - text.length, text,
                 taken: names.map((n) => n.trim().replace(/^"(.*)"$/, '$1')),
                 connection: CONNECTION_WORDS.has(edgeWord) && !(edgeWord === 'linkedto' && endsWithSource(head)) }
    }

    // Inside tier IN (… not yet closed: the next value, not one listed.
    const list = VALUE_LIST.exec(before)
    if (list) {
        const items = list[2].split(',')
        const last = (items.pop() ?? '').trimStart()
        const quote = /^["']/.test(last)
        const text = quote ? last.slice(1) : last
        return { kind: 'value', key: unquoteKey(list[1]), from: pos - text.length, text, quoted: quote,
                 taken: items.map((v) => v.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean) }
    }

    const duration = DURATION.exec(before)
    if (duration) return { kind: 'duration', from: pos - duration[1].length, text: duration[1] }

    const comparison = COMPARISON.exec(before)
    if (comparison) {
        const [, rawKey, , quote, text] = comparison
        return { kind: 'value', key: unquoteKey(rawKey), from: pos - text.length, text, quoted: Boolean(quote) }
    }

    // Right after a relationship or a connection's end: its edge filter.
    const dot = /\)\.([A-Za-z]*)$/.exec(before)
    if (dot) return { kind: 'via', from: pos - dot[1].length - 1, text: `.${dot[1]}` }

    // After a property's name: its operator, perhaps a word or two in.
    const operator = keyField ? operatorAt(before, keyField) : null
    if (operator) return { kind: 'operator', ...operator, from: pos - operator.text.length }

    // The word under the cursor; a comma belongs to ``prefix:a,b``.
    const word = /([^\s()"'!=<>]*)$/.exec(before)?.[1] ?? ''
    const colon = word.indexOf(':')
    if (colon > 0) {
        const prefix = PREFIXES[word.slice(0, colon).toLowerCase()]
        if (prefix) {
            const values = word.slice(colon + 1).split(',')
            const text = values.pop() ?? ''
            return { kind: 'prefixValue', prefix, from: pos - text.length, text, taken: values }
        }
    }
    const term = word.replace(/^.*,/, '')
    // Inside .via( not yet closed: the walked edges' fields.
    const via = before.lastIndexOf('.via(')
    if (via >= 0 && !closes(before.slice(via + 5))) {
        return { kind: 'edgeKey', from: pos - term.length, text: term }
    }
    // Right after from(…): where the edges go.
    if (endsWithSource(before.slice(0, pos - term.length))) {
        return { kind: 'connectionEnd', from: pos - term.length, text: term }
    }
    return { kind: 'term', from: pos - term.length, text: term }
}

function unquoteKey(raw: string): string {
    return raw.startsWith('"') ? raw.slice(1, -1) : raw
}

/** The names the parser reads as text fields (a name search's targets),
 *  and as the entity type. */
const TEXT_FIELDS = new Set(['name', 'qname', 'qualifiedname', 'desc', 'description', 'tag', 'tags'])
const TYPE_FIELDS = new Set(['type', 'entitytype'])

/** What ``key`` is on a comparison's left, by the parser's rules — a
 *  quoted name is always a property — or ``null`` when it is a word. */
export function comparedField(key: string, quoted: boolean, propertyKeys: readonly string[]): ComparedField | null {
    if (quoted) return 'property'
    const k = key.toLowerCase()
    if (TEXT_FIELDS.has(k)) return 'text'
    if (TYPE_FIELDS.has(k)) return 'type'
    if (k === 'layer') return 'layer'
    return propertyKeys.includes(key) ? 'property' : null
}

/** The order operators are offered in, most used first. */
const OPERATOR_ORDER: readonly PropertyOperator[] = ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte',
    'between', 'contains', 'notContains', 'startsWith', 'endsWith', 'containsAll', 'withinLast',
    'isSet', 'isNotSet', 'isEmpty', 'isNotEmpty']

/** The operators each kind of name takes: a property, every one the
 *  language has; a text field, the text ones; ``type``, a list; ``layer``,
 *  equality. */
export function fieldOperators(field: ComparedField): PropertyOperator[] {
    switch (field) {
        case 'text': return ['contains', 'notContains', 'startsWith', 'endsWith']
        case 'type': return ['in', 'notIn']
        case 'layer': return ['eq']
        case 'property': {
            const all = Object.keys(OPERATOR_TABLE) as PropertyOperator[]
            return [...OPERATOR_ORDER.filter((op) => all.includes(op)),
                ...all.filter((op) => !OPERATOR_ORDER.includes(op))]
        }
    }
}

/** A name, then the start of one of its operators, ending the text:
 *  ``owner ``, ``owner IS N``, ``"Asset Owner" NOT I``. A name that is no
 *  property is a word, and so is text that starts none of its operators. */
function operatorAt(
    before: string, keyField: (key: string, quoted: boolean) => ComparedField | null,
): { key: string; quoted: boolean; field: ComparedField; text: string } | null {
    // The longest operator begun wins: ``owner IS N`` is owner, then IS N.
    for (let words = 2; words >= 0; words -= 1) {
        const m = new RegExp(`(?:^|[\\s(!])("[^"]+"|[A-Za-z_][\\w.-]*)\\s+((?:[A-Za-z]+\\s+){${words}}[A-Za-z]*)$`)
            .exec(before)
        if (!m) continue
        // A word right after an operator is its value, not a name.
        const keyStart = before.length - m[0].length + m[0].indexOf(m[1])
        if (/(?:[=<>]|\bCONTAINS|\bWITH)\s*$/i.test(before.slice(0, keyStart))) continue
        const key = unquoteKey(m[1])
        const quoted = m[1].startsWith('"')
        const field = keyField(key, quoted)
        const typed = m[2].toUpperCase()
        if (field && fieldOperators(field).some((op) => PROP_OP_STR[op].startsWith(typed))) {
            return { key, quoted, field, text: m[2] }
        }
    }
    return null
}

/** How Code mode writes ``op`` after a name, as a snippet: a list in
 *  brackets, a range with AND, text in quotes. */
export function operatorSnippet(op: PropertyOperator): string {
    const word = PROP_OP_STR[op]
    const types = OPERATOR_TABLE[op].types as readonly string[]
    switch (arityOf(op)) {
        case 'none': return word
        case 'many': return `${word} (\${})`
        case 'pair': return `${word} \${1:low} AND \${2:high}`
        case 'duration': return `${word} \${}`
        default: return types.length === 1 && types[0] === 'string' ? `${word} "\${}"` : `${word} \${}`
    }
}

/** The operator as its completion shows it: what follows it as "…". */
function operatorText(op: PropertyOperator): string {
    const word = PROP_OP_STR[op]
    switch (arityOf(op)) {
        case 'none': return word
        case 'many': return `${word} (…)`
        case 'pair': return `${word} … AND …`
        default: return /^[A-Z]/.test(word) ? `${word} …` : word
    }
}

/** After ``c`` is applied, open the next list: the values it takes. */
function thenComplete(c: Completion): Completion {
    const apply = c.apply as (view: EditorView, completion: Completion, from: number, to: number) => void
    return {
        ...c,
        apply: (view: EditorView, completion: Completion, from: number, to: number) => {
            apply(view, completion, from, to)
            startCompletion(view)
        },
    }
}

/** The operators a name takes, in the Form's words — in order, ahead of
 *  the words that may start the next condition. */
function operatorOptions(field: ComparedField): Completion[] {
    const options = fieldOperators(field).map((op, i) => {
        const c = snippetCompletion(operatorSnippet(op), {
            label: operatorText(op),
            detail: field === 'type' ? `its type ${operatorLabel(op, 'string')}` : operatorLabel(op, 'string'),
            type: 'keyword', boost: 60 - i,
        })
        return arityOf(op) === 'none' || arityOf(op) === 'pair' ? c : thenComplete(c)
    })
    if (field !== 'property') return options
    return [...options, thenComplete(snippetCompletion('= {${}}', {
        label: '= {…}', detail: 'is the same as another of its properties', type: 'keyword', boost: 60 - options.length,
    }))]
}

/** How long, after ``WITHIN LAST``. */
const DURATIONS: Completion[] = ([
    ['24 hours', 'the last day'], ['7 days', 'the last week'], ['30 days', 'the last month'],
    ['90 days', 'the last quarter'], ['6 months', 'the last half-year'], ['1 year', 'the last year'],
] as const).map(([label, detail], i) => ({ label, detail, type: 'constant', boost: -i }))

/** What a comparison may end with, and the type an ``AS`` names. */
const SUFFIXES: readonly { text: string; detail: string; type?: ValueType }[] = [
    { text: 'AS TEXT', detail: 'compare as text', type: 'string' },
    { text: 'AS NUMBER', detail: 'compare as a number', type: 'number' },
    { text: 'AS DATE', detail: 'compare as a date', type: 'date' },
    { text: 'AS BOOLEAN', detail: 'compare as true or false', type: 'boolean' },
    { text: 'MATCH CASE', detail: 'capitals must match' },
    { text: 'INCLUDING MISSING', detail: 'also match entities without the property' },
]

/** The suffixes the comparison ending ``head`` takes: tried on the parser,
 *  and offered only where they change what it means — when Code mode
 *  would write them itself. */
export function suffixOptions(head: string): Completion[] {
    if (!/\S\s+$/.test(head)) return []
    const close = ')'.repeat(openBrackets(head))
    return SUFFIXES.filter((s) => {
        const probe = parsePredicate(`${head}${s.text}${close}`)
        const end = head.length + s.text.length
        if (probe.error || probe.tokens.some((t) => t.from >= head.length && t.to <= end && t.role !== 'keyword')) {
            return false
        }
        const p = lastComparison(probe.predicate)
        if (!p) return false
        const op = p.op ?? 'eq'
        const auto = predicateType({ op, value: p.value, valueKey: p.valueKey })
        if (s.type) {
            const types = OPERATOR_TABLE[op].types as readonly string[]
            return p.valueType === s.type && types.length > 1 && types.includes(s.type) && auto !== s.type
                && (p.valueKey != null || readsAs(p.value, s.type))
        }
        if (s.text === 'MATCH CASE') return p.caseSensitive === true && arityOf(op) !== 'none' && auto === 'string'
        return p.includeMissing === true && isNegative(op)
    }).map((s) => ({ label: s.text, detail: s.detail, type: 'keyword', boost: 4 }))
}

/** Whether a comparison's value (each one, for a list) can be read as
 *  ``type`` — what an ``AS`` needs to mean anything. */
function readsAs(value: unknown, type: ValueType): boolean {
    const items = Array.isArray(value) ? value : [value]
    return items.every((v) => {
        const text = String(v).trim()
        switch (type) {
            case 'number': return typeof v === 'number' || /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
            case 'date': return /^\d{4}-\d{2}-\d{2}/.test(text)
            case 'boolean': return typeof v === 'boolean' || /^(?:true|false)$/i.test(text)
            default: return true
        }
    })
}

/** The comparison written last in ``p`` — the one a suffix typed next
 *  belongs to. */
function lastComparison(p: Predicate | null | undefined): PropertyPredicate | null {
    if (!p) return null
    if (p.kind === 'property') return p
    if (p.kind === 'group') {
        for (let i = p.children.length - 1; i >= 0; i -= 1) {
            const found = lastComparison(p.children[i])
            if (found) return found
        }
        return null
    }
    if (p.kind === 'related') return lastComparison(p.where)
    if (p.kind === 'edges') return lastComparison(p.targetWhere) ?? lastComparison(p.sourceWhere)
    return null
}

/** How many brackets ``text`` leaves open, quotes aside. */
function openBrackets(text: string): number {
    let depth = 0
    let quote = ''
    for (const c of text) {
        if (quote) {
            if (c === quote) quote = ''
        } else if (c === '"' || c === "'") {
            quote = c
        } else if (c === '(') {
            depth += 1
        } else if (c === ')' && depth > 0) {
            depth -= 1
        }
    }
    return depth
}

/** Whether ``text`` ends with a whole ``from(…)`` — what a connection's
 *  ``to(`` or ``linkedTo(`` follows. */
function endsWithSource(text: string): boolean {
    const t = text.trimEnd()
    if (!t.endsWith(')')) return false
    let depth = 0
    for (let i = t.length - 1; i >= 0; i -= 1) {
        if (t[i] === ')') depth += 1
        else if (t[i] === '(') {
            depth -= 1
            if (depth === 0) return /(?:^|[\s(!])from$/i.test(t.slice(0, i))
        }
    }
    return false
}

/** Words whose brackets name edges, read with ``_`` and ``-`` left out: a
 *  connection's, which never walks the hierarchy, and those that count. */
const CONNECTION_WORDS = new Set(['feeds', 'fedby', 'linkedto', 'outgoing', 'incoming',
    'upstream', 'downstream', 'neighbor'])
const COUNTING_WORDS = new Set(['edges', 'noupstream', 'nodownstream', 'nolineage', 'hasupstream',
    'hasdownstream', 'noincoming', 'nooutgoing', 'nolinks', 'noedges', 'hasincoming', 'hasoutgoing'])

/** Whether ``text`` (after an opening bracket) closes it. */
function closes(text: string): boolean {
    let depth = 0
    for (const c of text) {
        if (c === '(') depth += 1
        else if (c === ')') {
            if (depth === 0) return true
            depth -= 1
        }
    }
    return false
}


/** Words and relationships a condition starts with. */
const TERMS: Completion[] = [
    snippetCompletion('type:${}', { label: 'type:', detail: 'its entity type', type: 'keyword', boost: 3 }),
    snippetCompletion('tag:${}', { label: 'tag:', detail: 'tagged with', type: 'keyword', boost: 2 }),
    snippetCompletion('layer:${}', { label: 'layer:', detail: 'in a layer', type: 'keyword' }),
    snippetCompletion('has:${}', { label: 'has:', detail: 'has a property', type: 'keyword' }),
    snippetCompletion('name CONTAINS "${}"', { label: 'name CONTAINS', detail: 'text in its name', type: 'keyword' }),
    snippetCompletion('qname:${}', { label: 'qname:', detail: 'text in its qualified name', type: 'keyword' }),
    snippetCompletion('description:${}', { label: 'description:', detail: 'text in its description', type: 'keyword' }),
    snippetCompletion('@"${}"', { label: '@"…"', detail: 'an entity, by name', type: 'keyword', boost: 2 }),
    snippetCompletion('inside @"${}"', { label: 'inside @"…"', detail: 'inside an entity', type: 'keyword' }),
    snippetCompletion('feeds(${})', { label: 'feeds(…)', detail: 'it feeds something that…', type: 'function', boost: 1 }),
    snippetCompletion('fedBy(${})', { label: 'fedBy(…)', detail: 'something feeds it that…', type: 'function', boost: 1 }),
    snippetCompletion('feeds*..3(${})', { label: 'feeds*..3(…)', detail: 'feeds, within 3 steps', type: 'function' }),
    snippetCompletion('fedBy*..3(${})', { label: 'fedBy*..3(…)', detail: 'fed by, within 3 steps', type: 'function' }),
    snippetCompletion('linkedTo(${})', { label: 'linkedTo(…)', detail: 'linked to, by any edge, either way', type: 'function', boost: 1 }),
    snippetCompletion('outgoing[${1}](${2})', { label: 'outgoing[…](…)', detail: 'links out through edge types…', type: 'function' }),
    snippetCompletion('incoming[${1}](${2})', { label: 'incoming[…](…)', detail: 'links in through edge types…', type: 'function' }),
    snippetCompletion('parent(${})', { label: 'parent(…)', detail: 'its container is…', type: 'function' }),
    snippetCompletion('ancestor(${})', { label: 'ancestor(…)', detail: 'inside something that…', type: 'function' }),
    snippetCompletion('ancestor*2(${})', { label: 'ancestor*2(…)', detail: 'two levels up is…', type: 'function' }),
    snippetCompletion('child(${})', { label: 'child(…)', detail: 'holds something that…', type: 'function' }),
    snippetCompletion('descendant(${})', { label: 'descendant(…)', detail: 'holds, at any depth…', type: 'function' }),
    snippetCompletion('root(${})', { label: 'root(…)', detail: 'its top-level container is…', type: 'function' }),
    snippetCompletion('every child(${})', { label: 'every child(…)', detail: 'all it holds is…', type: 'function' }),
    snippetCompletion('no fedBy(${})', { label: 'no fedBy(…)', detail: 'nothing feeding it is…', type: 'function' }),
    snippetCompletion('count(child(${})) > 0', { label: 'count(…)', detail: 'how many relatives are…', type: 'function' }),
    snippetCompletion('edges(${1:both}) > ${2:10}', { label: 'edges(…) >', detail: 'how many edges, in, out or both', type: 'function' }),
    snippetCompletion('from(${1}) to(${2})', { label: 'from(…) to(…)', detail: 'connections: the edges from … to …', type: 'function' }),
    snippetCompletion('from(${1}) linkedTo(${2})', { label: 'from(…) linkedTo(…)', detail: 'connections, either way', type: 'function' }),
    snippetCompletion('upstream(${})', { label: 'upstream(…)', detail: 'older spelling of fedBy(…)', type: 'function', boost: -1 }),
    snippetCompletion('downstream(${})', { label: 'downstream(…)', detail: 'older spelling of feeds(…)', type: 'function', boost: -1 }),
    snippetCompletion('neighbor(${})', { label: 'neighbor(…)', detail: 'older spelling of linkedTo[lineage](…)', type: 'function', boost: -1 }),
    { label: 'noUpstream', detail: 'nothing feeds it', type: 'keyword' },
    { label: 'noDownstream', detail: 'it feeds nothing', type: 'keyword' },
    { label: 'noLineage', detail: 'no lineage at all', type: 'keyword' },
    { label: 'noIncoming', detail: 'nothing links into it', type: 'keyword' },
    { label: 'noOutgoing', detail: 'it links to nothing', type: 'keyword' },
    { label: 'noLinks', detail: 'no links at all', type: 'keyword' },
    { label: 'noEdges', detail: 'no edges at all', type: 'keyword' },
    { label: 'hasUpstream', detail: 'something feeds it', type: 'keyword' },
    { label: 'hasDownstream', detail: 'it feeds something', type: 'keyword' },
    { label: 'hasIncoming', detail: 'something links into it', type: 'keyword' },
    { label: 'hasOutgoing', detail: 'it links to something', type: 'keyword' },
    { label: 'AND', type: 'keyword' },
    { label: 'OR', type: 'keyword' },
    { label: 'NOT', type: 'keyword' },
]

/** Where a connection's edges go, after ``from(…)``. */
const CONNECTION_ENDS: Completion[] = [
    snippetCompletion('to(${})', { label: 'to(…)', detail: 'to something that…, any link', type: 'function', boost: 2 }),
    snippetCompletion('to[${1}](${2})', { label: 'to[…](…)', detail: 'through these edges, to…', type: 'function', boost: 1 }),
    snippetCompletion('linkedTo(${})', { label: 'linkedTo(…)', detail: 'either way', type: 'function' }),
]

/** A relationship's or a connection's edge filter, after its ``)``. */
const VIA = thenComplete(snippetCompletion('.via(${})', {
    label: '.via(…)', detail: 'every edge it walks meets…', type: 'function',
}))

/** A word the language reads as one token, as typed; anything else quoted. */
function bare(text: string): boolean {
    return /^[^\s(),"'!=<>{}@]+$/.test(text) && !/^(and|or|not)$/i.test(text)
}

function quoted(text: string): string {
    return text.includes('"') ? `'${text}'` : `"${text}"`
}

/** The words joining conditions, and those operators and suffixes are made
 *  of — never a property's name. */
const RESERVED = /^(?:and|or|not|in|is|set|empty|contains|all|starts|ends|with|within|last|between|as|match|case|including|missing)$/i

/** Only one list's worth is shown at a time; CodeMirror narrows it. */
const MAX_OPTIONS = 200


/** The editor's completion: ``vocabulary()`` read at each request, so lists
 *  that load later are offered as soon as they arrive. */
export function dslCompletionSource(vocabulary: () => DslVocabulary): CompletionSource {
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const doc = context.state.doc.toString()
        const vocab = vocabulary()
        const listed = (key: string, isQuoted: boolean) => comparedField(key, isQuoted, vocab.propertyKeys)
        // A name the view doesn't list may be a property all the same; the
        // language's own words never are.
        const at = completionContextAt(doc, context.pos, (key, isQuoted) =>
            listed(key, isQuoted) ?? (RESERVED.test(key) ? null : 'property'))
        switch (at.kind) {
            case 'name':
                return nameCompletions(context, at, vocab)
            case 'prefixValue': {
                const list = at.prefix === 'type' ? vocab.entityTypes
                    : at.prefix === 'tag' ? vocab.tags
                        : at.prefix === 'layer' ? vocab.layers : vocab.propertyKeys
                const taken = new Set(at.taken)
                return {
                    from: at.from,
                    options: list.filter((v) => bare(v) && !taken.has(v)).slice(0, MAX_OPTIONS)
                        .map((v) => ({ label: v, type: 'constant' })),
                    validFor: /^[^\s(),"'!=<>]*$/,
                }
            }
            case 'value': {
                const taken = new Set(at.taken ?? [])
                // The entity type and a layer take the view's own lists.
                const own = at.taken && TYPE_FIELDS.has(at.key.toLowerCase()) ? vocab.entityTypes
                    : !at.taken && at.key.toLowerCase() === 'layer' ? vocab.layers : null
                if (own) {
                    return {
                        from: at.from,
                        options: own.filter((v) => !taken.has(v)).slice(0, MAX_OPTIONS)
                            .map((v) => ({ label: v, type: 'constant', apply: at.quoted || bare(v) ? v : quoted(v) })),
                        validFor: /^[^\s(),"'!=<>]*$/,
                    }
                }
                if (!vocab.suggestValues) return null
                const answer = await vocab.suggestValues(at.key, at.text).catch(() => null)
                if (context.aborted || !answer?.values?.length) return null
                return {
                    from: at.from,
                    options: answer.values.slice(0, MAX_OPTIONS).flatMap(({ value }) => {
                        if (value === null || value === undefined || typeof value === 'object') return []
                        const text = String(value)
                        if (!text || taken.has(text)) return []
                        return [{ label: text, type: 'constant',
                                  apply: at.quoted || bare(text) ? text : quoted(text) }]
                    }),
                    filter: false,
                }
            }
            case 'operator': {
                // After a name the view doesn't list, a word may follow just
                // as well: operators once one is begun, or asked for.
                if (!listed(at.key, at.quoted) && !at.text && !context.explicit) return null
                // A word in, it may as well start the next condition.
                const more = /\s/.test(at.text) ? [] : [...TERMS, ...keyOptions(vocab)]
                return { from: at.from, options: [...operatorOptions(at.field), ...more], validFor: /^[A-Za-z ]*$/ }
            }
            case 'duration':
                return { from: at.from, options: DURATIONS, validFor: /^[\w ]*$/ }
            case 'via':
                return { from: at.from, options: [VIA], validFor: /^\.\w*$/ }
            case 'edgeType': {
                const taken = new Set(at.taken.map((t) => t.toUpperCase()))
                return {
                    from: at.from,
                    options: [
                        // A class stands alone: offered as the first name only.
                        ...(at.taken.length ? [] : EDGE_SET_OPTIONS
                            .filter((o) => o.value !== 'types'
                                && (!at.connection || o.value === 'lineage' || o.value === 'links'))
                            .map((o) => ({ label: o.value, detail: o.description, type: 'keyword', boost: 1 }))),
                        ...(vocab.edgeTypes ?? [])
                            .filter((t) => !taken.has(t.id.toUpperCase()) && !(at.connection && t.containment))
                            .slice(0, MAX_OPTIONS)
                            // One named like a class goes in quotes, or it would read as the class.
                            .map((t) => ({ label: t.id, detail: t.detail, type: 'constant',
                                           ...(EDGE_CLASS_WORDS.has(t.id.toLowerCase()) ? { apply: `"${t.id}"` } : {}) })),
                    ],
                    validFor: /^[\w.-]*$/,
                }
            }
            case 'keyRef':
                return {
                    from: at.from,
                    options: vocab.propertyKeys.filter((k) => !/[{}":]/.test(k)).slice(0, MAX_OPTIONS)
                        .map((k) => ({ label: k, detail: 'another property', type: 'property' })),
                    validFor: /^[^{}":]*$/,
                }
            case 'edgeKey':
                if (!at.text && !context.explicit) return null
                return {
                    from: at.from,
                    options: vocab.edgeKeys.slice(0, MAX_OPTIONS).map((k) => ({
                        label: k, detail: 'edge field', type: 'property',
                        apply: bare(k) ? k : quoted(k),
                    })),
                    validFor: /^[\w.-]*$/,
                }
            case 'connectionEnd':
                return { from: at.from, options: CONNECTION_ENDS, validFor: /^[\w.*-]*$/ }
            case 'term': {
                const head = doc.slice(0, at.from)
                // Half a suffix typed: the rest of it.
                const half = /(^|\s)(AS|MATCH|INCLUDING)\s+$/i.exec(head)
                if (half) {
                    const start = half.index + half[1].length
                    const lead = half[2].toUpperCase()
                    const options = suffixOptions(head.slice(0, start)).filter((o) => o.label.startsWith(lead))
                    if (options.length) return { from: start, options, validFor: /^[A-Za-z ]*$/ }
                }
                if (!at.text && !context.explicit) return null
                return {
                    from: at.from,
                    options: [...suffixOptions(head), ...TERMS, ...keyOptions(vocab)],
                    validFor: /^[\w.*-]*$/,
                }
            }
        }
    }
}


/** The view's property keys, to start a comparison with. */
function keyOptions(vocab: DslVocabulary): Completion[] {
    return vocab.propertyKeys.slice(0, MAX_OPTIONS).map((k) => ({
        label: k, detail: 'property', type: 'property', apply: bare(k) ? k : quoted(k),
    }))
}


/** How long typing pauses before names are searched for. */
const NAME_PAUSE_MS = 250

async function nameCompletions(
    context: CompletionContext, at: { from: number; text: string }, vocab: DslVocabulary,
): Promise<CompletionResult | null> {
    const names = vocab.names
    if (!names || !at.text.trim()) return null
    const controller = new AbortController()
    context.addEventListener('abort', () => controller.abort())
    await new Promise((resolve) => setTimeout(resolve, NAME_PAUSE_MS))
    if (context.aborted) return null
    const found = await names.search(at.text, controller.signal).catch(() => [])
    if (context.aborted || !found.length) return null
    return {
        from: at.from,
        filter: false,
        options: found.map((entity) => ({
            label: entity.name,
            detail: [entity.type, entity.ancestors.join(' / ')].filter(Boolean).join(' · '),
            type: 'variable',
            apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
                void applyName(view, names.pathFor, entity, from, to)
            },
        })),
    }
}


/** Write the shortest path that names ``entity`` alone — or its URN — in
 *  place of the name being typed, and close the quote. Nothing is written
 *  if the text changed while the path was asked for. */
async function applyName(view: EditorView, pathFor: (e: NamedEntity) => Promise<NodeRef>,
                         entity: NamedEntity, from: number, to: number): Promise<void> {
    const typed = view.state.sliceDoc(from, to)
    const ref = await pathFor(entity).catch(() => ({ urn: entity.urn }) as NodeRef)
    if (view.state.sliceDoc(from, to) !== typed) return
    const text = ref.path ? formatNamePath(ref.path) : (ref.urn ?? entity.urn)
    const quote = view.state.sliceDoc(from - 1, from)
    const closed = view.state.sliceDoc(to, to + 1) === quote
    view.dispatch({
        changes: { from, to, insert: closed ? text : text + quote },
        selection: { anchor: from + text.length + 1 },
        userEvent: 'input.complete',
    })
}
