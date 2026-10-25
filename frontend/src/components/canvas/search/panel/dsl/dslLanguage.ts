/**
 * dslLanguage — the query language in a code editor, all of it read off the
 * one parser that also builds the query (``parsePredicate``):
 *
 *   highlighting   each token coloured for the part the parser read it as
 *   the underline  the parser's error, at the place it points to
 *   completion     what fits where the cursor is — entity types after
 *                  ``type:``, a property's values after ``owner =``, edge
 *                  fields inside ``.via(``, entities by name after ``@"``,
 *                  edge types inside ``outgoing[``, and words and
 *                  relationships to start a condition with
 *   warnings       an edge type this data source doesn't have
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
} from '@codemirror/autocomplete'
import { type Diagnostic, linter } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'

import type { NodeRef } from '@/types/search'

import type { RoleRange } from '../../editor/codeMirrorBase'
import type { NamedEntity } from '../entityNames'
import { type DslToken, parsePredicate } from '../predicateDsl'
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
            const name = part.trim()
            if (name && !EDGE_CLASS_WORDS.has(name.toLowerCase()) && !known.has(name.toUpperCase())) {
                const from = at + part.indexOf(name)
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
// Completion
// ---------------------------------------------------------------------------

/** What the cursor is in the middle of. ``from``: where the text being
 *  completed starts. */
export type DslCompletionContext =
    | { kind: 'name'; from: number; text: string }
    | { kind: 'prefixValue'; prefix: 'type' | 'tag' | 'layer' | 'has'; from: number; text: string;
        taken: string[] }
    | { kind: 'value'; key: string; from: number; text: string; quoted: boolean }
    | { kind: 'edgeKey'; from: number; text: string }
    | { kind: 'edgeType'; from: number; text: string; taken: string[]; connection: boolean }
    | { kind: 'term'; from: number; text: string }

const PREFIXES: Record<string, 'type' | 'tag' | 'layer' | 'has'> = {
    type: 'type', entitytype: 'type', tag: 'tag', tags: 'tag', layer: 'layer',
    has: 'has', hasproperty: 'has',
}

/** A comparison's key and operator just before the cursor: ``owner = ``,
 *  ``"Asset Owner" != "``, ``name CONTAINS ``. */
const COMPARISON = /(?:^|[\s(!])("[^"]+"|[A-Za-z_][\w.-]*)\s*(=|!=|<=|>=|<|>|\bCONTAINS\b|\bSTARTS\s+WITH\b|\bENDS\s+WITH\b)\s*(["']?)([^\s"'()]*)$/i


export function completionContextAt(doc: string, pos: number): DslCompletionContext {
    const before = doc.slice(0, pos)
    // Inside @"… not yet closed: an entity, by name.
    const ref = /@(["'])([^"']*)$/.exec(before)
    if (ref) return { kind: 'name', from: pos - ref[2].length, text: ref[2] }

    // Inside outgoing[… not yet closed: edge types — a connection's never
    // the hierarchy's.
    const bracket = /(?:^|[\s(!])([A-Za-z_-]+)(?:\*[\d.]*)?\[([^\]]*)$/.exec(before)
    const edgeWord = bracket?.[1].toLowerCase().replace(/[_-]/g, '') ?? ''
    if (bracket && (CONNECTION_WORDS.has(edgeWord) || COUNTING_WORDS.has(edgeWord))) {
        const names = bracket[2].split(',')
        const text = (names.pop() ?? '').trimStart()
        return { kind: 'edgeType', from: pos - text.length, text, taken: names.map((n) => n.trim()),
                 connection: CONNECTION_WORDS.has(edgeWord) }
    }

    const comparison = COMPARISON.exec(before)
    if (comparison) {
        const [, rawKey, , quote, text] = comparison
        const key = rawKey.startsWith('"') ? rawKey.slice(1, -1) : rawKey
        return { kind: 'value', key, from: pos - text.length, text, quoted: Boolean(quote) }
    }

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
    return { kind: 'term', from: pos - term.length, text: term }
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
    snippetCompletion('child(${})', { label: 'child(…)', detail: 'holds something that…', type: 'function' }),
    snippetCompletion('descendant(${})', { label: 'descendant(…)', detail: 'holds, at any depth…', type: 'function' }),
    snippetCompletion('root(${})', { label: 'root(…)', detail: 'its top-level container is…', type: 'function' }),
    snippetCompletion('every child(${})', { label: 'every child(…)', detail: 'all it holds is…', type: 'function' }),
    snippetCompletion('no fedBy(${})', { label: 'no fedBy(…)', detail: 'nothing feeding it is…', type: 'function' }),
    snippetCompletion('count(child(${})) > 0', { label: 'count(…)', detail: 'how many relatives are…', type: 'function' }),
    snippetCompletion('edges(${1:both}) > ${2:10}', { label: 'edges(…) >', detail: 'how many edges, in, out or both', type: 'function' }),
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
    { label: 'AND', type: 'keyword' },
    { label: 'OR', type: 'keyword' },
    { label: 'NOT', type: 'keyword' },
]

/** A word the language reads as one token, as typed; anything else quoted. */
function bare(text: string): boolean {
    return /^[^\s(),"'!=<>{}@]+$/.test(text) && !/^(and|or|not)$/i.test(text)
}

function quoted(text: string): string {
    return text.includes('"') ? `'${text}'` : `"${text}"`
}

/** Only one list's worth is shown at a time; CodeMirror narrows it. */
const MAX_OPTIONS = 200


/** The editor's completion: ``vocabulary()`` read at each request, so lists
 *  that load later are offered as soon as they arrive. */
export function dslCompletionSource(vocabulary: () => DslVocabulary): CompletionSource {
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const at = completionContextAt(context.state.doc.toString(), context.pos)
        const vocab = vocabulary()
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
                if (!vocab.suggestValues) return null
                const answer = await vocab.suggestValues(at.key, at.text).catch(() => null)
                if (context.aborted || !answer?.values?.length) return null
                return {
                    from: at.from,
                    options: answer.values.slice(0, MAX_OPTIONS).flatMap(({ value }) => {
                        if (value === null || value === undefined || typeof value === 'object') return []
                        const text = String(value)
                        return [{ label: text, type: 'constant',
                                  apply: at.quoted || bare(text) ? text : quoted(text) }]
                    }),
                    filter: false,
                }
            }
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
                            .map((t) => ({ label: t.id, detail: t.detail, type: 'constant' })),
                    ],
                    validFor: /^[\w.-]*$/,
                }
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
            case 'term':
                if (!at.text && !context.explicit) return null
                return {
                    from: at.from,
                    options: [
                        ...TERMS,
                        ...vocab.propertyKeys.slice(0, MAX_OPTIONS).map((k) => ({
                            label: k, detail: 'property', type: 'property',
                            apply: bare(k) ? k : quoted(k),
                        })),
                    ],
                    validFor: /^[\w.*-]*$/,
                }
        }
    }
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
