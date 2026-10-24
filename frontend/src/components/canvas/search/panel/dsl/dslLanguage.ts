/**
 * dslLanguage — the query language in a code editor, all of it read off the
 * one parser that also builds the query (``parsePredicate``):
 *
 *   highlighting   each token coloured for the part the parser read it as
 *   the underline  the parser's error, at the place it points to
 *   completion     what fits where the cursor is — entity types after
 *                  ``type:``, a property's values after ``owner =``, edge
 *                  fields inside ``.via(``, entities by name after ``@"``,
 *                  and words and relationships to start a condition with
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
import { parsePredicate } from '../predicateDsl'
import { formatNamePath } from '../relations'


/** What the editor completes from — the view's vocabulary. */
export interface DslVocabulary {
    entityTypes: readonly string[]
    tags: readonly string[]
    /** Layer values (``layer:`` takes a layer's value). */
    layers: readonly string[]
    propertyKeys: readonly string[]
    edgeKeys: readonly string[]
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
 *  character when it points past the end ("it ends too soon"). */
export function dslDiagnostics(text: string): Diagnostic[] {
    const result = parsePredicate(text)
    if (!result.error) return []
    let from = Math.min(result.errorAt?.from ?? 0, text.length)
    let to = Math.min(result.errorAt?.to ?? text.length, text.length)
    if (to <= from) {
        from = Math.max(0, text.length - 1)
        to = text.length
    }
    return [{ from, to, severity: 'error', message: result.error }]
}

export const dslLint = linter((view) => dslDiagnostics(view.state.doc.toString()), { delay: 200 })


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
    snippetCompletion('upstream(${})', { label: 'upstream(…)', detail: 'something feeds it that…', type: 'function', boost: 1 }),
    snippetCompletion('downstream(${})', { label: 'downstream(…)', detail: 'it feeds something that…', type: 'function', boost: 1 }),
    snippetCompletion('upstream*..3(${})', { label: 'upstream*..3(…)', detail: 'within 3 hops upstream', type: 'function' }),
    snippetCompletion('downstream*..3(${})', { label: 'downstream*..3(…)', detail: 'within 3 hops downstream', type: 'function' }),
    snippetCompletion('neighbor(${})', { label: 'neighbor(…)', detail: 'lineage either way', type: 'function' }),
    snippetCompletion('parent(${})', { label: 'parent(…)', detail: 'its container is…', type: 'function' }),
    snippetCompletion('ancestor(${})', { label: 'ancestor(…)', detail: 'inside something that…', type: 'function' }),
    snippetCompletion('child(${})', { label: 'child(…)', detail: 'holds something that…', type: 'function' }),
    snippetCompletion('descendant(${})', { label: 'descendant(…)', detail: 'holds, at any depth…', type: 'function' }),
    snippetCompletion('root(${})', { label: 'root(…)', detail: 'its top-level container is…', type: 'function' }),
    snippetCompletion('every child(${})', { label: 'every child(…)', detail: 'all it holds is…', type: 'function' }),
    snippetCompletion('no upstream(${})', { label: 'no upstream(…)', detail: 'nothing feeding it is…', type: 'function' }),
    snippetCompletion('count(child(${})) > 0', { label: 'count(…)', detail: 'how many relatives are…', type: 'function' }),
    { label: 'noUpstream', detail: 'nothing feeds it', type: 'keyword' },
    { label: 'noDownstream', detail: 'it feeds nothing', type: 'keyword' },
    { label: 'noLineage', detail: 'no lineage at all', type: 'keyword' },
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
