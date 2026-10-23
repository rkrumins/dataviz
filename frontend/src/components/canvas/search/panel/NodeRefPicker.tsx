/**
 * NodeRefPicker — name an entity the way people do. Start typing its name
 * and pick it from the suggestions, each shown where it sits; the picker
 * writes the shortest path of names that names only that entity —
 * ``Finance / orders``, or ``** / fact_orders / channel`` — so a saved
 * query or rule keeps working after a view or library moves. A path can be
 * typed too (``Country / United Kingdom``, ``**`` for any number of levels)
 * or a URN pasted. **Pin** fixes the one entity a path names by its URN, so
 * a rename can't change what it means; **Use its name** turns it back.
 *
 * As a path is typed, the server says what it names (POST
 * /search/resolve): one entity, several — every one is used — or none,
 * with the first few shown where they sit.
 */
import { Pin, Plus, X } from 'lucide-react'
import { type FC, useContext, useEffect, useId, useMemo, useState } from 'react'

import { rememberUrnLabels, urnDisplayName } from '@/lib/urnLabels'
import { cn } from '@/lib/utils'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import type { AncestorRef, NodeRef } from '@/types/search'

import { inputClass } from '../typed/fieldStyles'

import { ANY_DEPTH, pathCandidates, refText, textToRef } from './relations'
import { RelationContext } from './relationContext'


/** An entity as the picker shows it: name, type, and its containers' names, top first. */
interface Entity {
    urn: string
    name: string
    type: string
    ancestors: string[]
}

type Resolution =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; count: number; matches: Entity[] }
    | { status: 'error'; message: string }

/** Suggestions offered for a typed name. */
const SUGGESTIONS = 8


function entityOf(e: { urn: string; displayName?: string | null; entityType?: string | null;
                       ancestorPath?: AncestorRef[] | null }): Entity {
    return {
        urn: e.urn, name: e.displayName || e.urn, type: e.entityType ?? '',
        ancestors: (e.ancestorPath ?? []).map((a) => a.displayName),
    }
}


/** The provider and view a picker asks, or nulls when it can't (a preview:
 *  the picker still edits, without the help). */
function useRemote(): [RemoteGraphProvider | null, string | null] {
    const provider = useGraphProviderIfAvailable()
    const { viewId } = useContext(RelationContext)
    return provider instanceof RemoteGraphProvider && viewId ? [provider, viewId] : [null, null]
}


function useResolution(ref: NodeRef | null): Resolution {
    const [remote, viewId] = useRemote()
    // An answer counts for the reference it was asked for; until the
    // current one's arrives, it is loading.
    const [answered, setAnswered] = useState<{ key: string; resolution: Resolution } | null>(null)
    const key = ref && remote ? `${viewId} ${JSON.stringify(ref)}` : ''
    useEffect(() => {
        if (!key || !ref || !remote || !viewId) return
        const controller = new AbortController()
        const settle = (resolution: Resolution) => setAnswered({ key, resolution })
        const timer = setTimeout(() => {
            remote.resolveSearchRefs({ scope: { viewId }, refs: [ref] }, { signal: controller.signal })
                .then((result) => {
                    const answer = result.results[0]
                    if (!answer) return settle({ status: 'idle' })
                    if (answer.error) return settle({ status: 'error', message: answer.error })
                    rememberUrnLabels(answer.matches ?? [])
                    settle({ status: 'done', count: answer.count,
                             matches: (answer.matches ?? []).slice(0, 3).map(entityOf) })
                })
                .catch((e: unknown) => {
                    if (controller.signal.aborted) return
                    settle({ status: 'error', message: e instanceof Error ? e.message : String(e) })
                })
        }, 300)
        return () => { clearTimeout(timer); controller.abort() }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])
    if (!key) return { status: 'idle' }
    return answered?.key === key ? answered.resolution : { status: 'loading' }
}


/** The view's entities whose name holds ``word`` — the last word's while
 *  asking, so the list doesn't flicker as you type. */
function useSuggestions(word: string | null): Entity[] | null {
    const [remote, viewId] = useRemote()
    const [answered, setAnswered] = useState<Entity[] | null>(null)
    const key = word && remote ? `${viewId} ${word}` : ''
    useEffect(() => {
        if (!key || !word || !remote || !viewId) return
        const controller = new AbortController()
        const timer = setTimeout(() => {
            remote.searchAdvanced({
                predicate: { kind: 'group', op: 'and', children: [
                    { kind: 'text', value: word, target: 'name', match: 'substring' }] },
                scope: { viewId, scopeMode: 'view' },
                options: { results: 'hits', pageSize: SUGGESTIONS, includeAncestorPath: true,
                           highlights: false, waitMs: 800 },
            }, { signal: controller.signal })
                .then((page) => setAnswered((page.hits ?? []).map((h) =>
                    entityOf({ ...h.node, ancestorPath: h.ancestorPath }))))
                .catch(() => { if (!controller.signal.aborted) setAnswered([]) })
        }, 250)
        return () => { clearTimeout(timer); controller.abort() }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])
    return key ? answered : null
}


/** The shortest path of names that names ``entity`` alone in the view —
 *  every candidate checked in one request — or its URN when none does. */
async function namePathFor(remote: RemoteGraphProvider, viewId: string, entity: Entity): Promise<NodeRef> {
    const candidates = pathCandidates(entity.name, entity.ancestors)
    if (!candidates.length) return { urn: entity.urn }
    try {
        const { results } = await remote.resolveSearchRefs(
            { scope: { viewId }, refs: candidates.map((path) => ({ path })) })
        const i = results.findIndex((r) => r.count === 1 && r.matches?.[0]?.urn === entity.urn)
        return i >= 0 ? { path: candidates[i] } : { urn: entity.urn }
    } catch {
        return { urn: entity.urn }
    }
}


export interface NodeRefPickerProps {
    value: NodeRef | null
    onChange: (next: NodeRef | null) => void
    placeholder?: string
    autoFocus?: boolean
    disabled?: boolean
}


export const NodeRefPicker: FC<NodeRefPickerProps> = ({
    value, onChange, placeholder = 'Type a name — or a path like Country / United Kingdom', autoFocus,
    disabled,
}) => {
    const [remote, viewId] = useRemote()
    const [text, setText] = useState(() => refText(value))
    // Typed since the last pick: the suggestions are open.
    const [typing, setTyping] = useState(false)
    const [highlight, setHighlight] = useState(0)
    // Naming a picked entity, or turning a pinned one back into its name.
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState<string | null>(null)
    // Change on a pinned entity opens its URN for editing.
    const [editing, setEditing] = useState(false)
    const listId = useId()
    // Follow a value changed from outside (Code mode, undo) unless it is
    // what the text already says.
    const outside = refText(value)
    const [seen, setSeen] = useState(outside)
    if (outside !== seen) {
        setSeen(outside)
        if (JSON.stringify(textToRef(text)) !== JSON.stringify(value ?? null)) setText(outside)
    }
    const ref = useMemo(() => textToRef(text), [text])
    const resolution = useResolution(ref)
    const word = typing && !ref?.urn && !text.includes('/') && text.trim().length >= 2 ? text.trim() : null
    const suggestions = useSuggestions(word)
    const open = !!word && !!suggestions?.length
    const index = Math.min(highlight, (suggestions?.length ?? 1) - 1)
    const single = resolution.status === 'done' && resolution.count === 1 ? resolution.matches[0] : null
    // A pinned entity, not being typed, shows by name and where it sits —
    // by the name it's remembered by until the server answers.
    const remembered = value?.urn && resolution.status === 'loading' ? urnDisplayName(value.urn) : undefined
    const pinned = value?.urn && !editing && !typing
        ? single ?? (remembered ? { urn: value.urn, name: remembered, type: '', ancestors: [] } : null)
        : null

    const withBusy = async <T,>(work: Promise<T>): Promise<T> => {
        setBusy(true)
        try { return await work } finally { setBusy(false) }
    }
    // Remembered before it's committed, so the sentence and chips name it.
    const pin = (entity: Entity) => {
        rememberUrnLabels([{ urn: entity.urn, displayName: entity.name }])
        setEditing(false)
        onChange({ urn: entity.urn })
    }
    const choose = async (entity: Entity) => {
        setTyping(false)
        setNote(null)
        setText(entity.name)
        const next = remote && viewId ? await withBusy(namePathFor(remote, viewId, entity)) : { urn: entity.urn }
        if (next.urn) return pin(entity)
        setEditing(false)
        setText(refText(next))
        onChange(next)
    }
    const nameIt = async (entity: Entity) => {
        if (!remote || !viewId) return
        const next = await withBusy(namePathFor(remote, viewId, entity))
        if (next.urn) {
            setNote('No path of names names only this entity, so it stays pinned.')
            return
        }
        setEditing(false)
        setText(refText(next))
        onChange(next)
    }

    if (pinned) {
        return (
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 rounded-md border border-glass-border bg-canvas-base/40 px-2 py-1.5">
                    <Pin className="w-3.5 h-3.5 shrink-0 text-accent-lineage" aria-hidden />
                    <div className="flex-1 min-w-0">
                        <div className="truncate text-[12.5px] text-ink">
                            {pinned.name}
                            {pinned.type && <span className="ml-1.5 text-[10.5px] text-ink-muted">{pinned.type}</span>}
                        </div>
                        {pinned.ancestors.length > 0 && (
                            <div className="truncate text-[10.5px] text-ink-muted">{pinned.ancestors.join(' / ')}</div>
                        )}
                    </div>
                    <button type="button" disabled={disabled || busy || !single} onClick={() => { if (single) void nameIt(single) }}
                            title="Name it by its path instead, so it means the same in every environment"
                            className="shrink-0 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50">
                        {busy ? '…' : 'Use its name'}
                    </button>
                    <button type="button" disabled={disabled} onClick={() => setEditing(true)}
                            className="shrink-0 text-[11px] text-ink-muted hover:text-ink">
                        Change
                    </button>
                </div>
                {note && <p className="pl-1 text-[10.5px] text-ink-muted">{note}</p>}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <input
                    type="text" value={text} placeholder={placeholder} autoFocus={autoFocus || editing}
                    disabled={disabled} aria-label="Entity by name path or URN"
                    role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
                    onChange={(e) => {
                        setText(e.target.value)
                        setTyping(true)
                        setHighlight(0)
                        setNote(null)
                        onChange(textToRef(e.target.value))
                    }}
                    onKeyDown={(e) => {
                        if (!open || !suggestions) return
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault()
                            const step = e.key === 'ArrowDown' ? 1 : -1
                            setHighlight(Math.max(0, Math.min(suggestions.length - 1, index + step)))
                        } else if (e.key === 'Enter') {
                            e.preventDefault()
                            void choose(suggestions[index])
                        } else if (e.key === 'Escape') {
                            // Closes the suggestions, not the panel.
                            e.preventDefault()
                            e.stopPropagation()
                            setTyping(false)
                        }
                    }}
                    onBlur={() => { setTyping(false); setEditing(false) }}
                    className={cn(inputClass, 'flex-1 min-w-0 text-[12.5px]')}
                />
                {busy ? <ResolutionBadge state={{ status: 'loading' }} />
                    : !open && <ResolutionBadge state={resolution} />}
                {single && value?.path && !open && (
                    <button type="button" disabled={disabled} onClick={() => pin(single)}
                            aria-label="Pin this exact entity"
                            title="Pin this exact entity, by its URN, so a rename can't change what it means"
                            className="shrink-0 text-ink-muted hover:text-accent-lineage">
                        <Pin className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
            {open && suggestions && (
                <ul id={listId} role="listbox" aria-label="Matching entities"
                    className="flex flex-col rounded-md border border-glass-border bg-canvas-elevated py-1 shadow-lg">
                    {suggestions.map((s, i) => (
                        <li key={s.urn} role="option" aria-selected={i === index}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setHighlight(i)}
                            onClick={() => void choose(s)}
                            className={cn('cursor-pointer px-2.5 py-1.5', i === index && 'bg-accent-lineage/12')}>
                            <div className="flex items-baseline gap-1.5 min-w-0">
                                <span className="truncate text-[12.5px] text-ink">{s.name}</span>
                                {s.type && <span className="shrink-0 text-[10.5px] text-ink-muted">{s.type}</span>}
                            </div>
                            {s.ancestors.length > 0 && (
                                <div className="truncate text-[10.5px] text-ink-muted">{s.ancestors.join(' / ')}</div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!open && resolution.status === 'done'
                && (resolution.count > 1 || resolution.matches.some((m) => m.ancestors.length > 0)) && (
                <ul className="flex flex-col gap-0.5 pl-1">
                    {resolution.matches.map((m, i) => (
                        <li key={i} className="text-[10.5px] text-ink-muted truncate">
                            {m.ancestors.length > 0 && <span className="text-ink-muted/70">{m.ancestors.join(' / ')} / </span>}
                            <span className="text-ink">{m.name}</span>
                        </li>
                    ))}
                    {resolution.count > resolution.matches.length && (
                        <li className="text-[10.5px] text-ink-muted/70">
                            and {resolution.count - resolution.matches.length} more — every one is used
                        </li>
                    )}
                </ul>
            )}
            {!open && resolution.status === 'done' && resolution.count === 0 && ref?.path && ref.path[0] !== ANY_DEPTH && (
                <p className="pl-1 text-[10.5px] text-ink-muted">
                    A path starts at the top. Pick a suggestion as you type, or begin with ** / to look at any depth.
                </p>
            )}
            {note && <p className="pl-1 text-[10.5px] text-ink-muted">{note}</p>}
        </div>
    )
}


const ResolutionBadge: FC<{ state: Resolution }> = ({ state }) => {
    if (state.status === 'idle') return null
    const [text, tone] =
        state.status === 'loading' ? ['…', 'text-ink-muted border-glass-border']
            : state.status === 'error' ? ['can\'t resolve', 'text-rose-400 border-rose-500/30']
                : state.count === 0 ? ['not found', 'text-rose-400 border-rose-500/30']
                    : state.count === 1 ? ['1 entity', 'text-emerald-500 border-emerald-500/30']
                        : [`${state.count} entities`, 'text-amber-500 border-amber-500/30']
    return (
        <span title={state.status === 'error' ? state.message : undefined}
              className={cn('shrink-0 px-1.5 py-0.5 rounded border text-[10.5px] tabular-nums', tone)}>
            {text}
        </span>
    )
}


/** Several references, one picker each, and room for another. A row
 *  being typed counts once it names something. */
export const NodeRefList: FC<{
    value: NodeRef[]
    onChange: (next: NodeRef[]) => void
    autoFocus?: boolean
    disabled?: boolean
}> = ({ value, onChange, autoFocus, disabled }) => {
    const [typing, setTyping] = useState(value.length ? 0 : 1)
    const rows: (NodeRef | null)[] = [...value, ...Array.from({ length: typing }, () => null)]
    return (
        <div className="flex flex-col gap-2">
            {rows.map((ref, i) => (
                <div key={i} className="flex items-start gap-1.5">
                    <div className="flex-1 min-w-0">
                        <NodeRefPicker
                            value={ref}
                            autoFocus={autoFocus && i === 0}
                            disabled={disabled}
                            onChange={(next) => {
                                if (i >= value.length) {
                                    if (next) {
                                        setTyping((n) => Math.max(0, n - 1))
                                        onChange([...value, next])
                                    }
                                    return
                                }
                                const copy = [...value]
                                if (next) copy[i] = next
                                else copy.splice(i, 1)
                                if (!copy.length) setTyping(1)
                                onChange(copy)
                            }}
                        />
                    </div>
                    {rows.length > 1 && (
                        <button type="button" aria-label="Remove this entity" disabled={disabled}
                                onClick={() => {
                                    if (i >= value.length) setTyping((n) => Math.max(0, n - 1))
                                    else onChange(value.filter((_, j) => j !== i))
                                }}
                                className="mt-1.5 text-ink-muted/70 hover:text-rose-400">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            ))}
            {typing === 0 && (
                <button type="button" disabled={disabled} onClick={() => setTyping(1)}
                        className="self-start inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink">
                    <Plus className="w-3 h-3" /> another entity
                </button>
            )}
        </div>
    )
}
