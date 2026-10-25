/**
 * AskBar — ask the view a question in plain words.
 *
 *   ✦ datasets that feed finance dashboards                         ↵
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ READS AS                                                    12 │
 *   │ Find [Datasets] that [feed] [Dashboards] that are tagged #Finance│
 *   │ “finance” as  (a tag) (inside a container) (a name)             │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * What it reads is shown before anything changes, in the Sentence's own
 * words, with roughly how many it matches; a word with other readings
 * offers them, and names are looked up in the view. Enter applies it —
 * replacing the query, or adding to it when the question starts with
 * "and". ↑ / ↓ bring back earlier questions; Esc clears.
 */
import * as Popover from '@radix-ui/react-popover'
import { CheckCircle2, ChevronDown, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { usePersonaMode } from '@/store/persona'
import { useSearchStore } from '@/store/searchStore'
import type { NodeRef, Predicate } from '@/types/search'

import type { CountState } from '../counts/useCounts'
import { namedEntityOf, namePathFor } from '../entityNames'
import { useTypeName } from '../sentence/useTypeName'

import { askExamples } from './askExamples'
import { readHistory, remember } from './askHistory'
import type { AskVocabulary } from './askVocabulary'
import type { AskPicks } from './interpretQuestion'
import { ReadsAs } from './ReadsAs'
import { useAskPreview, type NameLookup, type NameMatch } from './useAskPreview'


export interface AskBarProps {
    viewId: string | null
    vocabulary: AskVocabulary
    /** The query a question starting with "and" adds to. */
    draft: Predicate | null
    /** Apply the query a question leaves. */
    onAsk: (result: Predicate) => void
    /** The types this view holds, most common first — for the examples. */
    presentTypes: readonly string[]
    /** ``hero``: the empty card's front door, examples beneath. */
    variant?: 'hero' | 'compact'
    disabled?: boolean
}


export function AskBar({ viewId, vocabulary, draft, onAsk, presentTypes, variant = 'compact',
    disabled = false }: AskBarProps) {
    const [question, setQuestion] = useState('')
    const [picks, setPicks] = useState<AskPicks>({})
    const [recall, setRecall] = useState<number | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const persona = usePersonaMode()
    const typeName = useTypeName()
    const hero = variant === 'hero'
    const asking = question.trim().length > 0

    // "Ask about this view", chosen from outside the panel, lands here.
    const askFocus = useSearchStore((s) => s.pendingAskFocus)
    useEffect(() => {
        if (askFocus && useSearchStore.getState().consumeAskFocus()) inputRef.current?.focus()
    }, [askFocus])

    const preview = useAskPreview(viewId, question, vocabulary, picks, draft)
    const { interpretation, result } = preview
    const examples = useMemo(() => askExamples(presentTypes, vocabulary.tags, typeName, persona),
        [presentTypes, vocabulary.tags, typeName, persona])

    const clear = useCallback(() => {
        setQuestion('')
        setPicks({})
        setRecall(null)
    }, [])
    const apply = useCallback(() => {
        if (!result || disabled) return
        remember(question.trim())
        onAsk(result)
        clear()
    }, [result, disabled, question, onAsk, clear])

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); apply(); return }
        if (e.key === 'Escape' && asking) { e.preventDefault(); e.stopPropagation(); clear(); return }
        if ((e.key === 'ArrowUp' && (!asking || recall !== null)) || (e.key === 'ArrowDown' && recall !== null)) {
            const history = readHistory()
            const at = e.key === 'ArrowUp' ? Math.min((recall ?? -1) + 1, history.length - 1) : (recall ?? 0) - 1
            if (history.length === 0) return
            e.preventDefault()
            if (at < 0) { clear(); return }
            setRecall(at)
            setQuestion(history[at])
            setPicks({})
        }
    }

    const pick = (id: string, reading: string) =>
        setPicks((p) => ({ ...p, choices: { ...p.choices, [id]: reading } }))
    const pickName = (text: string, ref: NodeRef) =>
        setPicks((p) => ({ ...p, names: { ...p.names, [text]: ref } }))

    // Said once the count settles, for anyone not watching the preview.
    const live = asking && preview.countStatus === 'done' && preview.count
        ? `${preview.count.count.toLocaleString()}${preview.count.complete ? '' : ' or more'} matches`
        : ''

    return (
        <div className="flex flex-col gap-2">
            <div className={cn(
                'group flex items-center gap-2 rounded-xl border bg-canvas-elevated/80 px-3 transition-shadow',
                'border-glass-border focus-within:border-accent-lineage/50 focus-within:ring-2 focus-within:ring-accent-lineage/20',
                hero ? 'h-12 shadow-sm' : 'h-9',
            )}>
                <Sparkles className={cn('shrink-0 text-accent-lineage', hero ? 'h-5 w-5' : 'h-4 w-4')} aria-hidden />
                <input
                    ref={inputRef}
                    type="text"
                    value={question}
                    onChange={(e) => { setQuestion(e.target.value); setRecall(null) }}
                    onKeyDown={onKeyDown}
                    disabled={disabled}
                    autoFocus={hero}
                    aria-label="Ask about this view"
                    placeholder={hero ? 'Ask in plain words…'
                        : 'Ask to change the query — start with “and” to add to it'}
                    className={cn('min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-muted/80',
                        hero ? 'text-base' : 'text-sm')}
                />
                {asking && (
                    <>
                        <button type="button" onClick={clear} aria-label="Clear the question"
                                className="rounded-md p-0.5 text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                            <X className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={apply} disabled={!result || disabled}
                                className={cn(
                                    'inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors',
                                    'bg-accent-lineage text-white hover:bg-accent-lineage/90 disabled:opacity-40',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                )}>
                            {interpretation.mode === 'add' ? 'Add' : 'Apply'}
                            <CornerDownLeft className="h-3 w-3" aria-hidden />
                        </button>
                    </>
                )}
            </div>

            {asking ? (
                <div className="flex flex-col gap-2 rounded-xl border border-glass-border bg-canvas-elevated/60 p-3">
                    <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                                {interpretation.mode === 'add' ? 'The query becomes' : 'Reads as'}
                            </div>
                            <div className="text-sm">
                                {result
                                    ? <ReadsAs predicate={result} />
                                    : <span className="text-ink-muted">Keep going — name a type, a tag, a relationship…</span>}
                            </div>
                        </div>
                        <CountBadge count={preview.count} status={preview.countStatus} shown={!!result} />
                    </div>
                    {interpretation.ambiguities.map((a) => (
                        <div key={a.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="text-ink-muted">“{a.text}” as</span>
                            {a.choices.map((c) => (
                                <button key={c.id} type="button" aria-pressed={c.id === a.picked}
                                        onClick={() => pick(a.id, c.id)}
                                        className={cn(
                                            'rounded-full border px-2 py-0.5 transition-colors',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                            c.id === a.picked
                                                ? 'border-accent-lineage/40 bg-accent-lineage/10 text-accent-lineage'
                                                : 'border-black/10 text-ink-muted hover:text-ink dark:border-white/15',
                                        )}>
                                    {c.label}
                                </button>
                            ))}
                        </div>
                    ))}
                    {interpretation.names.map((n) => (
                        <NameLine key={n.text} text={n.text} lookup={preview.lookups.get(n.text) ?? { status: 'unknown' }}
                                  viewId={viewId} onPick={(ref) => pickName(n.text, ref)} />
                    ))}
                    {interpretation.unrecognized.length > 0 && (
                        <p className="text-xs text-ink-muted">
                            Searched for by name: {interpretation.unrecognized.map((w) => `“${w}”`).join(', ')}
                        </p>
                    )}
                </div>
            ) : hero && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-ink-muted">Try</span>
                    {examples.map((q) => (
                        <button key={q} type="button" disabled={disabled}
                                onClick={() => { setQuestion(q); inputRef.current?.focus() }}
                                className="rounded-full border border-black/10 bg-canvas-elevated/60 px-2.5 py-1 text-ink transition-colors hover:border-accent-lineage/40 hover:text-accent-lineage focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:border-white/15">
                            {q}
                        </button>
                    ))}
                </div>
            )}
            <div aria-live="polite" className="sr-only">{live}</div>
        </div>
    )
}


function CountBadge({ count, status, shown }: { count: CountState | null; status: string; shown: boolean }) {
    if (!shown || status === 'unavailable') return null
    if (!count) return status === 'counting' ? <Skeleton className="mt-1 h-5 w-12 shrink-0 rounded-md" /> : null
    const zero = count.complete && count.count === 0
    return (
        <div className={cn('flex shrink-0 flex-col items-end', !count.complete && 'opacity-80')}>
            <span className={cn('text-base font-semibold tabular-nums leading-tight',
                zero ? 'text-rose-500 dark:text-rose-400' : 'text-ink')}>
                {count.count.toLocaleString()}{count.complete ? '' : '+'}
            </span>
            <span className="text-2xs text-ink-muted">{zero ? 'no matches' : 'matches'}</span>
        </div>
    )
}


/** A name the question points at, as found in the view — and, when it
 *  names several, the one meant. */
function NameLine({ text, lookup, viewId, onPick }: {
    text: string
    lookup: NameLookup
    viewId: string | null
    onPick: (ref: NodeRef) => void
}) {
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const [open, setOpen] = useState(false)
    if (lookup.status === 'unknown') return null
    const choose = async (m: NameMatch) => {
        setOpen(false)
        onPick(remote && viewId ? await namePathFor(remote, viewId, namedEntityOf(m)) : { urn: m.urn })
    }
    return (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-ink-muted">“{text}”</span>
            {lookup.status === 'looking' && (
                <span className="inline-flex items-center gap-1 text-ink-muted">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> looking in this view…
                </span>
            )}
            {lookup.status === 'found' && (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" aria-hidden /> found{lookup.matches[0]
                        ? ` — ${lookup.matches[0].entityType}` : ''}
                </span>
            )}
            {lookup.status === 'none' && (
                <span className="text-rose-600 dark:text-rose-400">nothing by that name in this view</span>
            )}
            {lookup.status === 'several' && (
                <Popover.Root open={open} onOpenChange={setOpen}>
                    <Popover.Trigger asChild>
                        <button type="button"
                                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">
                            names {lookup.count.toLocaleString()} entities — pick one <ChevronDown className="h-3 w-3" aria-hidden />
                        </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content align="start" sideOffset={6} collisionPadding={12} aria-label={`Which “${text}”`}
                                         data-floating-layer=""
                                         className="z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-2xl shadow-black/25">
                            {lookup.matches.map((m) => (
                                <button key={m.urn} type="button" onClick={() => void choose(m)}
                                        className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
                                    <span className="text-sm text-ink">{m.displayName}
                                        <span className="ml-1.5 text-xs text-ink-muted">{m.entityType}</span></span>
                                    {m.ancestorPath && m.ancestorPath.length > 0 && (
                                        <span className="text-xs text-ink-muted">
                                            in {m.ancestorPath.map((a) => a.displayName).join(' / ')}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </Popover.Content>
                    </Popover.Portal>
                </Popover.Root>
            )}
        </div>
    )
}
