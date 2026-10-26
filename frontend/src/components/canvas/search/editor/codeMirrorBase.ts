/**
 * codeMirrorBase — what every code editor in the search panel shares: the
 * look (the app's own colour tokens, so light and dark both work without
 * reconfiguring), the keys, and highlighting by token role.
 *
 * Highlighting is decorations computed from a language's own tokenizer —
 * the query language's parser, a Cypher lexer — rather than a second
 * grammar, so what is coloured is always what is read.
 */
import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    type CompletionSource,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import {
    Decoration,
    type DecorationSet,
    EditorView,
    keymap,
    placeholder as placeholderText,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view'


/** A highlighted range: the part a token plays. */
export interface RoleRange {
    from: number
    to: number
    role: string
}

/** How each role looks — Tailwind classes, so dark mode follows the app. */
export const ROLE_CLASSES: Record<string, string> = {
    keyword: 'text-indigo-600 dark:text-indigo-300 font-semibold',
    function: 'text-cyan-700 dark:text-cyan-300 font-semibold',
    ref: 'text-violet-700 dark:text-violet-300',
    field: 'text-amber-700 dark:text-amber-300',
    prefix: 'text-amber-700 dark:text-amber-300',
    operator: 'text-slate-500 dark:text-slate-400',
    value: 'text-emerald-700 dark:text-emerald-300',
    number: 'text-sky-700 dark:text-sky-300',
    text: 'text-ink',
    json: 'text-slate-600 dark:text-slate-300',
    comment: 'text-slate-400 dark:text-slate-500 italic',
    param: 'text-rose-700 dark:text-rose-300',
    label: 'text-teal-700 dark:text-teal-300',
    punct: 'text-slate-400 dark:text-slate-500',
}

const MARKS: Record<string, Decoration> = Object.fromEntries(
    Object.entries(ROLE_CLASSES).map(([role, cls]) => [role, Decoration.mark({ class: cls })]),
)


/** Highlighting from a tokenizer: ``ranges(text)`` is run on the whole
 *  document when it changes — queries are short, and one source of truth
 *  beats an incremental second grammar. */
export function roleHighlighting(ranges: (text: string) => RoleRange[]): Extension {
    const build = (view: EditorView): DecorationSet => {
        const builder = new RangeSetBuilder<Decoration>()
        let last = 0
        for (const r of ranges(view.state.doc.toString())) {
            const mark = MARKS[r.role]
            if (!mark || r.to <= r.from || r.from < last) continue
            builder.add(r.from, r.to, mark)
            last = r.to
        }
        return builder.finish()
    }
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet
        constructor(view: EditorView) { this.decorations = build(view) }
        update(update: ViewUpdate) {
            if (update.docChanged) this.decorations = build(update.view)
        }
    }, { decorations: (v) => v.decorations })
}


/** The editor's chrome in the app's colour tokens (they switch with the
 *  theme), the completion list and lint tooltips included. */
export const editorChrome = EditorView.theme({
    '&': {
        fontSize: '12.5px',
        color: 'var(--nx-text-primary)',
        backgroundColor: 'transparent',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        caretColor: 'var(--nx-text-primary)',
        padding: '6px 0',
    },
    '.cm-line': { padding: '0 10px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--nx-text-primary)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(var(--nx-accent-lineage-rgb), 0.22)',
    },
    '.cm-placeholder': { color: 'var(--nx-text-muted)' },
    '.cm-gutters': {
        backgroundColor: 'transparent',
        borderRight: '1px solid var(--nx-border-subtle)',
        color: 'var(--nx-text-muted)',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(var(--nx-divider-rgb), 0.04)' },
    '.cm-tooltip': {
        backgroundColor: 'var(--nx-bg-elevated)',
        color: 'var(--nx-text-primary)',
        border: '1px solid var(--nx-border-subtle)',
        borderRadius: '8px',
        boxShadow: 'var(--nx-shadow-md)',
        overflow: 'hidden',
    },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: 'rgba(var(--nx-accent-lineage-rgb), 0.16)',
        color: 'var(--nx-text-primary)',
    },
    '.cm-completionDetail': { color: 'var(--nx-text-muted)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
    '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'inherit' },
    '.cm-lintRange-error': {
        backgroundImage: 'none',
        textDecoration: 'underline wavy rgb(244 63 94)',
        textUnderlineOffset: '3px',
    },
})


/** The keys and behaviour every editor here has. ``complete``: the
 *  completion sources, when the language offers any. */
export function baseExtensions({ placeholder, ariaLabel, complete }: {
    placeholder?: string
    ariaLabel: string
    complete?: CompletionSource[]
}): Extension[] {
    return [
        history(),
        closeBrackets(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
        ...(placeholder ? [placeholderText(placeholder)] : []),
        ...(complete?.length ? [autocompletion({ override: complete, activateOnTyping: true })] : []),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
        editorChrome,
    ]
}
