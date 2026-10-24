/**
 * Code mode — write the query in the query language, with the editor's help
 * (``DslEditor``): what it reads as, in words, while you type; the error,
 * where it points, when it doesn't parse — and a query that doesn't parse is
 * never applied, so the one you had stays; examples to start from.
 *
 * The text follows the query from outside (the visual builder, undo, a
 * canvas question) until you type; then your text waits, and what you apply
 * comes back in your own spelling.
 */
import { AlertCircle, ArrowRight, CheckCircle2, Lightbulb } from 'lucide-react'
import { type FC, useCallback, useId, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { formatPredicateAsSentence } from '../predicateSentence'
import { parsePredicate, stringifyPredicate, type ParseResult } from '../predicateDsl'

import { DslEditor, type DslEditorHandle } from './DslEditor'
import type { DslVocabulary } from './dslLanguage'


export function CodeMode({
    draft, isRunning, onCommit, vocabulary,
}: {
    draft: Predicate | null
    isRunning: boolean
    onCommit: (p: Predicate | null) => void
    vocabulary: DslVocabulary
}) {
    const shown = stringifyPredicate(draft)
    const [text, setText] = useState(shown)
    // Typed since the text last matched the draft: only then is there
    // anything to apply, and only then does a change from outside (a
    // canvas question, How it matches, undo) wait instead of replacing it.
    const [typed, setTyped] = useState(false)
    // What the last apply sent: when it comes back as the draft, the box
    // keeps the user's own spelling.
    const [applied, setApplied] = useState<string | null>(null)
    const [seen, setSeen] = useState(shown)
    if (shown !== seen) {
        setSeen(shown)
        setApplied(null)
        if (shown !== applied && !typed) setText(shown)
    }

    const parsed = useMemo(() => parsePredicate(text), [text])
    const commit = useCallback(() => {
        // A query that doesn't parse is never applied: the one you had stays.
        if (!typed || parsed.error) return
        setTyped(false)
        setApplied(stringifyPredicate(parsed.predicate))
        onCommit(parsed.predicate)
    }, [typed, parsed, onCommit])
    const revert = useCallback(() => {
        setText(shown)
        setTyped(false)
    }, [shown])
    const onChange = useCallback((next: string) => {
        setText(next)
        setTyped(true)
    }, [])

    const editor = useRef<DslEditorHandle>(null)
    const statusId = useId()

    return (
        <div className="flex flex-col gap-1.5">
            <div className={cn(
                'rounded-lg border bg-canvas-base/60 transition-colors',
                parsed.error && typed ? 'border-rose-500/50' : 'border-glass-border',
                'focus-within:border-accent-lineage/60',
            )}>
                <DslEditor
                    ref={editor}
                    value={text}
                    onChange={onChange}
                    onApply={commit}
                    onRevert={revert}
                    onBlur={commit}
                    vocabulary={vocabulary}
                    disabled={isRunning}
                    ariaLabel="Query in the query language"
                    ariaDescribedBy={statusId}
                    placeholder='type:dataset AND upstream*..3(@"Sales") — start typing for suggestions'
                />
            </div>
            <ParseStatus id={statusId} parsed={parsed} pending={typed} />
            <Examples
                vocabulary={vocabulary}
                defaultOpen={!text.trim()}
                onInsert={(example) => {
                    // "|" marks where the cursor goes: between the quotes of @"".
                    const caret = example.indexOf('|')
                    editor.current?.insert(example.replace('|', ''), caret >= 0 ? caret : undefined)
                }}
            />
            <div className="text-[10.5px] text-ink-muted/70 px-1">
                <kbd className="px-1 rounded bg-glass/40 text-ink-muted">⌘↵</kbd> or click away to apply ·{' '}
                <kbd className="px-1 rounded bg-glass/40 text-ink-muted">Esc</kbd> to undo your edit ·{' '}
                <kbd className="px-1 rounded bg-glass/40 text-ink-muted">Ctrl Space</kbd> for suggestions
            </div>
        </div>
    )
}


/** Whether it parses, what it reads as — announced to screen readers. */
function ParseStatus({ id, parsed, pending }: { id: string; parsed: ParseResult; pending: boolean }) {
    let body
    if (parsed.error) {
        body = (
            <div className="flex items-start gap-1.5 text-rose-600 dark:text-rose-300">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span className="leading-snug">
                    {parsed.error}
                    {pending && <span className="text-ink-muted"> — not applied until it reads.</span>}
                </span>
            </div>
        )
    } else if (!parsed.predicate) {
        body = <div className="text-ink-muted/80">Empty query — type to start, or pick an example.</div>
    } else {
        const words = parsed.fallbackText.length
        body = (
            <div className="flex flex-col gap-0.5">
                <div className="flex items-start gap-1.5 text-ink-secondary">
                    <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span className="leading-snug">
                        <span className="text-ink-muted">Reads as: </span>
                        {formatPredicateAsSentence(parsed.predicate, { leadIn: 'Anything', singular: true })}
                    </span>
                </div>
                {words > 0 && (
                    <div className="pl-[18px] text-ink-muted">
                        {words} word{words === 1 ? '' : 's'} searched as text in names:{' '}
                        <span className="font-mono">{parsed.fallbackText.join(' ')}</span>
                    </div>
                )}
            </div>
        )
    }
    return <div id={id} role="status" aria-live="polite" className="px-1 text-[11px]">{body}</div>
}


/** Example queries by task, using the view's own types, tags and keys when
 *  it has them. */
function exampleGroups(v: DslVocabulary): { task: string; items: [string, string][] }[] {
    const type = v.entityTypes[0] ?? 'dataset'
    const otherType = v.entityTypes.find((t) => t !== type) ?? 'dashboard'
    const tag = v.tags.find((t) => /^[\w.-]+$/.test(t)) ?? 'PII'
    const key = v.propertyKeys.find((k) => /^[A-Za-z_][\w.-]*$/.test(k)) ?? 'owner'
    return [
        { task: 'Find by name or type', items: [
            ['customer', 'a name containing "customer"'],
            [`type:${type}`, `every ${type}`],
            [`type:${type} AND tag:${tag}`, `${type}s tagged ${tag}`],
        ] },
        { task: 'Compare properties', items: [
            [`${key} IS SET`, `has a ${key}`],
            [`${key} = "value"`, `${key} is exactly "value"`],
            ['updated WITHIN LAST 30 DAYS', 'a date in the last 30 days'],
        ] },
        { task: 'Follow lineage', items: [
            [`upstream(type:${type})`, `something feeding it is a ${type}`],
            [`downstream*..3(type:${otherType})`, `feeds a ${otherType} within 3 hops`],
            ['upstream().via(confidence >= 0.8)', 'fed through confident edges'],
            ['noDownstream', 'feeds nothing'],
        ] },
        { task: 'Containers and names', items: [
            [`parent(type:${type})`, `its container is a ${type}`],
            ['count(child()) > 100', 'holds more than 100 things'],
            ['inside @"|"', 'inside an entity — type its name'],
        ] },
        { task: 'Combine', items: [
            [`type:${type} AND (tag:${tag} OR ${key} IS SET)`, 'AND, OR and brackets'],
            [`NOT tag:${tag}`, 'leave things out'],
        ] },
    ]
}


const Examples: FC<{
    vocabulary: DslVocabulary
    defaultOpen: boolean
    onInsert: (text: string) => void
}> = ({ vocabulary, defaultOpen, onInsert }) => {
    const [open, setOpen] = useState(defaultOpen)
    const groups = useMemo(() => exampleGroups(vocabulary), [vocabulary])
    return (
        <div className="rounded-md border border-glass-border/50 bg-canvas-base/40 overflow-hidden">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'w-full flex items-center justify-between gap-2',
                    'px-2.5 py-1.5 text-[10.5px] text-ink-muted',
                    'hover:bg-canvas-base/70 transition-colors',
                )}
            >
                <span className="inline-flex items-center gap-1.5">
                    <Lightbulb className="w-3 h-3" /> Examples — click one to add it
                </span>
                <ArrowRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
            </button>
            {open && (
                <div className="px-2 pb-2 flex flex-col gap-2">
                    {groups.map((g) => (
                        <div key={g.task}>
                            <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/80">
                                {g.task}
                            </div>
                            <div className="flex flex-col">
                                {g.items.map(([example, says]) => (
                                    <button
                                        key={example}
                                        type="button"
                                        aria-label={`Add ${example.replace('|', '')}: ${says}`}
                                        onClick={() => onInsert(example)}
                                        className={cn(
                                            'flex items-baseline gap-2 px-1.5 py-1 rounded text-left',
                                            'hover:bg-accent-lineage/10 transition-colors',
                                        )}
                                    >
                                        <span className="font-mono text-[11px] text-ink">{example.replace('|', '')}</span>
                                        <span className="text-[10.5px] text-ink-muted truncate">{says}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
