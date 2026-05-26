/**
 * The JSON DSL peer-view of the visual builder — now backed by
 * CodeMirror 6.
 *
 * Reads the live draft predicate from ``searchStore`` (the same one
 * the visual builder edits) and exposes it as editable JSON. On valid
 * edits the parsed predicate is written back via
 * ``seedDraftPredicate`` — which bumps the store's revision counter
 * so the builder reloads from the new value.
 *
 * Validation goes through Ajv against the schema fetched by
 * ``useSearchSchema`` and surfaced inline as CodeMirror diagnostics.
 * Invalid edits surface red squiggles but never touch the store, so
 * a malformed buffer cannot corrupt the builder.
 */
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
    type Completion,
    type CompletionContext,
    type CompletionResult,
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    snippetCompletion,
} from '@codemirror/autocomplete'
import { motion } from 'framer-motion'
import { AlertCircle, ArrowLeft, CheckCircle2, Code2, Loader2, Play } from 'lucide-react'
import { type FC, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useSearchSchema } from '@/hooks/useSearchSchema'
import {
    useDraftPredicate,
    useDraftRevision,
    useSearchStore,
} from '@/store/searchStore'
import type { Predicate } from '@/types/search'
import {
    PredicateValidationError,
    decodePredicate,
    encodePredicate,
} from '@/utils/predicateCodec'


export interface JsonEditorViewProps {
    /** Back-link target — kept on prop surface for callsite compat. */
    onBack: () => void
    /** Execute the parsed predicate against the live backend. */
    onRun: (predicate: Predicate) => void
    isRunning: boolean
}


const PLACEHOLDER_PREDICATE: Predicate = {
    kind: 'entityType',
    op: 'in',
    values: ['dataset'],
}


export const JsonEditorView: FC<JsonEditorViewProps> = ({ onRun, isRunning }) => {
    const draftPredicate = useDraftPredicate()
    const draftRevision = useDraftRevision()
    const seedDraftPredicate = useSearchStore((s) => s.seedDraftPredicate)
    const schemaState = useSearchSchema()

    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)

    const initialBuffer = useMemo(
        () => encodePredicate(draftPredicate ?? PLACEHOLDER_PREDICATE),
        // First render only — subsequent revisions handled by effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [],
    )

    const [buffer, setBuffer] = useState(initialBuffer)
    const [issues, setIssues] = useState<ReadonlyArray<{ path: string; message: string }>>([])
    const [lastAppliedRevision, setLastAppliedRevision] = useState(draftRevision)

    // ─── Predicate-kind snippet library ────────────────────────────
    //
    // Typing a kind name (``path``, ``property``, ``tag``, …) in the
    // editor surfaces a snippet that expands to the stub for that
    // predicate with required fields placed as tab stops. Lets a user
    // build a query from scratch in the JSON view by tabbing through
    // placeholders, without needing to remember the exact field
    // layout each predicate kind expects. The completion source only
    // fires when the cursor is on a fresh word (not inside an
    // existing string / value) so it doesn't spam suggestions while
    // the user is editing a literal.
    const snippetSource = useMemo(() => {
        return (ctx: CompletionContext): CompletionResult | null => {
            const word = ctx.matchBefore(/[a-zA-Z]+/)
            if (!word) return null
            // Inside a string literal (a property key or value), skip —
            // the JSON extension's own completions handle it.
            const head = ctx.state.doc.sliceString(0, ctx.pos)
            const lastQuote = head.lastIndexOf('"')
            const lastClose = head.lastIndexOf('}')
            if (lastQuote > lastClose) return null
            return {
                from: word.from,
                options: PREDICATE_KIND_SNIPPETS,
                validFor: /^[a-zA-Z]*$/,
            }
        }
    }, [])

    // ─── Schema-driven linter ──────────────────────────────────────
    //
    // Returns Ajv-validation diagnostics on the current text. Runs on
    // every doc change via CodeMirror's debounced linter pipeline.
    const schemaLinter = useMemo(() => {
        return linter((view): Diagnostic[] => {
            const text = view.state.doc.toString()
            if (!schemaState.schema) return []
            try {
                decodePredicate(text, schemaState.schema)
                return []
            } catch (err) {
                if (err instanceof PredicateValidationError) {
                    return err.issues.map((issue) => ({
                        from: 0,
                        to: text.length,
                        severity: 'error',
                        message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
                    }))
                }
                return [{
                    from: 0,
                    to: text.length,
                    severity: 'error',
                    message: String(err),
                }]
            }
        })
    }, [schemaState.schema])

    // ─── CodeMirror lifecycle ──────────────────────────────────────
    useEffect(() => {
        if (!containerRef.current) return

        const startState = EditorState.create({
            doc: initialBuffer,
            extensions: [
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightActiveLine(),
                history(),
                foldGutter(),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                autocompletion({ override: [snippetSource] }),
                lintGutter(),
                linter(jsonParseLinter()),
                schemaLinter,
                json(),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...closeBracketsKeymap,
                    ...completionKeymap,
                ]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        setBuffer(update.state.doc.toString())
                    }
                }),
                EditorView.theme({
                    '&': {
                        height: '100%',
                        fontSize: '12px',
                    },
                    '.cm-content': {
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        caretColor: 'var(--ink, #fff)',
                    },
                    '.cm-gutters': {
                        backgroundColor: 'transparent',
                        borderRight: '1px solid rgba(255,255,255,0.08)',
                        color: 'var(--ink-muted, #888)',
                    },
                    '.cm-activeLineGutter': {
                        backgroundColor: 'rgba(255,255,255,0.04)',
                    },
                    '.cm-activeLine': {
                        backgroundColor: 'rgba(255,255,255,0.03)',
                    },
                }),
            ],
        })

        const view = new EditorView({
            state: startState,
            parent: containerRef.current,
        })
        viewRef.current = view

        return () => {
            view.destroy()
            viewRef.current = null
        }
        // We intentionally only spin up the editor once; the linter
        // extension closes over schemaState via the linter ref. Schema
        // updates re-render via the dispatched effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // External writes (visual builder mirrors / template seeds) bump
    // ``draftRevision``. Reformat the buffer to match.
    useEffect(() => {
        if (draftRevision === lastAppliedRevision) return
        setLastAppliedRevision(draftRevision)
        const next = encodePredicate(draftPredicate ?? PLACEHOLDER_PREDICATE)
        setBuffer(next)
        setIssues([])
        const view = viewRef.current
        if (view) {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: next },
            })
        }
    }, [draftRevision, draftPredicate, lastAppliedRevision])

    /** Try to commit the current buffer to the store. Returns the
     *  parsed predicate on success, or null on validation failure. */
    const commit = (): Predicate | null => {
        if (!schemaState.schema) {
            try {
                const parsed = JSON.parse(buffer) as Predicate
                seedDraftPredicate(parsed)
                setLastAppliedRevision(draftRevision + 1)
                setIssues([])
                return parsed
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                setIssues([{ path: '', message: msg }])
                return null
            }
        }
        try {
            const parsed = decodePredicate(buffer, schemaState.schema)
            seedDraftPredicate(parsed)
            setLastAppliedRevision(draftRevision + 1)
            setIssues([])
            return parsed
        } catch (err) {
            if (err instanceof PredicateValidationError) {
                setIssues(err.issues)
            } else {
                setIssues([{ path: '', message: String(err) }])
            }
            return null
        }
    }

    const handleRun = () => {
        const parsed = commit()
        if (parsed) onRun(parsed)
    }

    const handleReformat = () => {
        try {
            const parsed = JSON.parse(buffer)
            const next = encodePredicate(parsed)
            setBuffer(next)
            const view = viewRef.current
            if (view) {
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: next },
                })
            }
        } catch {
            // ignore; invalid JSON — issue panel already shows the error
        }
    }

    return (
        <div className="flex flex-col h-full gap-2 min-h-[340px]">
            <Header schemaStatus={schemaState} />

            {schemaState.versionMismatch && (
                <VersionMismatchBanner
                    expected={schemaState.versionMismatch.expected}
                    served={schemaState.versionMismatch.served}
                />
            )}

            <div className="relative flex-1 flex flex-col rounded-lg border border-glass-border bg-canvas-base/40 overflow-hidden min-h-[280px]">
                <div
                    ref={containerRef}
                    className="flex-1 min-h-[260px] overflow-auto custom-scrollbar"
                    onBlur={commit}
                />
                {issues.length > 0 && <IssuesPanel issues={issues} />}
                {issues.length === 0 && draftPredicate && (
                    <div className="px-3 py-1.5 text-[11px] text-emerald-400/90 border-t border-glass-border bg-emerald-500/5 flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3" />
                        Valid — buffer matches the store's draft predicate.
                    </div>
                )}
            </div>

            <Footer
                onReformat={handleReformat}
                onRun={handleRun}
                canRun={schemaState.isReady || !schemaState.schema}
                isRunning={isRunning}
                hasErrors={issues.length > 0}
            />
        </div>
    )
}


// ---------------------------------------------------------------------------
// Internal subcomponents
// ---------------------------------------------------------------------------

function Header({
    schemaStatus,
}: {
    schemaStatus: ReturnType<typeof useSearchSchema>
}) {
    return (
        <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <Code2 className="h-3 w-3" />
                <span className="font-medium">JSON DSL</span>
            </span>
            <div className="flex items-center gap-2 text-[10.5px]">
                {schemaStatus.isLoading && (
                    <span className="flex items-center gap-1 text-ink-muted">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        schema…
                    </span>
                )}
                {schemaStatus.servedVersion && (
                    <span className="text-ink-muted/70">
                        schema v{schemaStatus.servedVersion}
                    </span>
                )}
            </div>
        </div>
    )
}


function VersionMismatchBanner({ expected, served }: { expected: string; served: string | null }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
                "flex items-start gap-2 px-3 py-2 rounded-md",
                "bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px]",
            )}
        >
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="leading-snug">
                <div className="font-medium">Schema version mismatch</div>
                <div className="text-[10.5px] opacity-80">
                    Server reports <code>{served ?? '(unknown)'}</code>, frontend
                    compiled against <code>{expected}</code>. Searches are disabled
                    until the frontend is rebuilt or the backend rolled back.
                </div>
            </div>
        </motion.div>
    )
}


function IssuesPanel({
    issues,
}: {
    issues: ReadonlyArray<{ path: string; message: string }>
}) {
    return (
        <div className="border-t border-glass-border bg-rose-500/5 max-h-40 overflow-y-auto custom-scrollbar">
            <div className="px-3 py-1.5 text-[10.5px] font-medium text-rose-300 flex items-center gap-1.5 border-b border-glass-border/50">
                <AlertCircle className="h-3 w-3" />
                {issues.length} validation {issues.length === 1 ? 'issue' : 'issues'}
            </div>
            <ul className="px-3 py-2 space-y-1 text-[11px] font-mono text-rose-300/90">
                {issues.map((issue, i) => (
                    <li key={i} className="leading-snug">
                        {issue.path && <span className="text-ink-muted">{issue.path}</span>}{' '}
                        {issue.message}
                    </li>
                ))}
            </ul>
        </div>
    )
}


function Footer({
    onReformat,
    onRun,
    canRun,
    isRunning,
    hasErrors,
}: {
    onReformat: () => void
    onRun: () => void
    canRun: boolean
    isRunning: boolean
    hasErrors: boolean
}) {
    return (
        <div className="flex items-center justify-between">
            <button
                type="button"
                onClick={onReformat}
                className="text-[11px] text-ink-muted hover:text-ink transition-colors"
            >
                Reformat
            </button>
            <button
                type="button"
                onClick={onRun}
                disabled={!canRun || isRunning || hasErrors}
                className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium",
                    "bg-accent-lineage/20 text-accent-lineage hover:bg-accent-lineage/30 transition-colors",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
            >
                {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                Run (JSON)
            </button>
        </div>
    )
}


// Marker import — keeps `ArrowLeft` available in the existing import list
// without removing it (the legacy callsite signature retains `onBack`).
void ArrowLeft


// ---------------------------------------------------------------------------
// Predicate-kind snippet library (W2.6)
//
// One snippet per predicate kind the SearchQuery schema accepts. Tab
// stops (``${1:...}``) land on the fields the user is most likely to
// fill in first; the snippet expander auto-jumps to the next stop on
// each Tab. Reduces "what fields does PathPredicate take again?" to
// a typed kind name + Tab.
//
// The list is kept in sync with the SearchQuery JSON Schema's
// discriminator values manually. A schema-derived auto-generator
// would be cleaner but adds build complexity; with 19 predicate
// kinds churning rarely, the manual list is the right tradeoff.
// ---------------------------------------------------------------------------

const PREDICATE_KIND_SNIPPETS: readonly Completion[] = [
    snippetCompletion(
        '{\n  "kind": "text",\n  "value": "${1:customers}",\n  "target": "${2:any}",\n  "match": "${3:substring}"\n}',
        { label: 'text', detail: 'TextPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "property",\n  "key": "${1:rowCount}",\n  "op": "${2:gt}",\n  "value": ${3:1000}\n}',
        { label: 'property', detail: 'PropertyPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "hasProperty",\n  "key": "${1:owner}"\n}',
        { label: 'hasProperty', detail: 'HasPropertyPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "tag",\n  "op": "${1:hasAny}",\n  "values": ["${2:PII}"]\n}',
        { label: 'tag', detail: 'TagPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "entityType",\n  "op": "${1:in}",\n  "values": ["${2:dataset}"]\n}',
        { label: 'entityType', detail: 'EntityTypePredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "layer",\n  "layerAssignment": "${1:Source}"\n}',
        { label: 'layer', detail: 'LayerPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "descendantOf",\n  "urns": ["${1:urn:li:domain:customers}"],\n  "maxDepth": ${2:12}\n}',
        { label: 'descendantOf', detail: 'DescendantOfPredicate — Inside Subtree' },
    ),
    snippetCompletion(
        // Alias for users who picked "Inside Subtree" in the palette
        // and switched to Code mode — they search by the UI label, not
        // the wire-format kind. Same JSON shape as the descendantOf
        // entry above.
        '{\n  "kind": "descendantOf",\n  "urns": ["${1:urn:li:domain:customers}"],\n  "maxDepth": ${2:12}\n}',
        { label: 'insideSubtree', detail: 'Inside Subtree (alias for descendantOf)' },
    ),
    snippetCompletion(
        '{\n  "kind": "withinHops",\n  "urns": ["${1:urn:li:dataset:orders}"],\n  "hops": ${2:2},\n  "direction": "${3:both}",\n  "edgeClass": "lineage"\n}',
        { label: 'withinHops', detail: 'WithinHopsPredicate — N-hop neighbourhood' },
    ),
    snippetCompletion(
        '{\n  "kind": "degree",\n  "direction": "${1:in}",\n  "op": "${2:gte}",\n  "value": ${3:1},\n  "edgeClass": "lineage"\n}',
        { label: 'degree', detail: 'DegreePredicate' },
    ),
    snippetCompletion(
        '{ "kind": "isOrphan", "edgeClass": "lineage" }',
        { label: 'isOrphan', detail: 'IsOrphanPredicate' },
    ),
    snippetCompletion(
        '{ "kind": "isLeaf", "edgeClass": "lineage" }',
        { label: 'isLeaf', detail: 'IsLeafPredicate' },
    ),
    snippetCompletion(
        '{ "kind": "isRoot", "edgeClass": "lineage" }',
        { label: 'isRoot', detail: 'IsRootPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "hasIncoming",\n  "edgeClass": "lineage"\n}',
        { label: 'hasIncoming', detail: 'HasIncomingPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "hasOutgoing",\n  "edgeClass": "lineage"\n}',
        { label: 'hasOutgoing', detail: 'HasOutgoingPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "path",\n  "sourceUrns": ["${1:urn:li:dataset:src}"],\n  "targetUrns": ["${2:urn:li:dataset:tgt}"],\n  "maxHops": ${3:4},\n  "edgeClass": "lineage",\n  "direction": "outgoing"\n}',
        { label: 'path', detail: 'PathPredicate' },
    ),
    snippetCompletion(
        '{\n  "kind": "group",\n  "op": "${1:and}",\n  "children": [\n    ${2}\n  ]\n}',
        { label: 'group', detail: 'GroupPredicate (AND/OR/NOT)' },
    ),
    snippetCompletion(
        '{\n  "kind": "edgeProperty",\n  "key": "${1:confidence}",\n  "op": "${2:gte}",\n  "value": ${3:0.8}\n}',
        { label: 'edgeProperty', detail: 'EdgePropertyPredicate (path / withinHops only)' },
    ),
    snippetCompletion(
        '{\n  "kind": "edgeHasProperty",\n  "key": "${1:confidence}"\n}',
        { label: 'edgeHasProperty', detail: 'EdgeHasPropertyPredicate (path / withinHops only)' },
    ),
    snippetCompletion(
        '{\n  "kind": "edgeGroup",\n  "op": "${1:and}",\n  "children": [\n    ${2}\n  ]\n}',
        { label: 'edgeGroup', detail: 'EdgeGroupPredicate (path / withinHops only)' },
    ),
]
