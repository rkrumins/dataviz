/**
 * NodeRefPicker — name an entity by its path of display names instead of
 * its URN: ``Country / United Kingdom``, ``Country / ** / London`` (``**``:
 * any number of levels), ``** / London`` (anywhere in the view). A URN
 * pasted in names that entity. A path names the same entity in every
 * environment, so a saved query or rule that uses one keeps working after
 * a view or library moves.
 *
 * As the path is typed, the server says what it names (POST
 * /search/resolve): one entity, several — every one is used — or none,
 * with the first few shown where they sit.
 */
import { Plus, X } from 'lucide-react'
import { type FC, useContext, useEffect, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import type { NodeRef } from '@/types/search'

import { inputClass } from '../typed/fieldStyles'

import { refText, textToRef } from './relations'
import { RelationContext } from './relationContext'


type Resolution =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; count: number; matches: { name: string; where: string }[] }
    | { status: 'error'; message: string }


function useResolution(ref: NodeRef | null): Resolution {
    // The badge is a help, so a row outside a provider (a preview) still edits.
    const provider = useGraphProviderIfAvailable()
    const { viewId } = useContext(RelationContext)
    // An answer counts for the reference it was asked for; until the
    // current one's arrives, it is loading.
    const [answered, setAnswered] = useState<{ key: string; resolution: Resolution } | null>(null)
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const key = ref && viewId && remote ? `${viewId} ${JSON.stringify(ref)}` : ''
    useEffect(() => {
        if (!key || !ref || !viewId || !remote) return
        const controller = new AbortController()
        const settle = (resolution: Resolution) => setAnswered({ key, resolution })
        const timer = setTimeout(() => {
            remote.resolveSearchRefs({ scope: { viewId }, refs: [ref] }, { signal: controller.signal })
                .then((result) => {
                    const answer = result.results[0]
                    if (!answer) return settle({ status: 'idle' })
                    if (answer.error) return settle({ status: 'error', message: answer.error })
                    settle({
                        status: 'done', count: answer.count,
                        matches: (answer.matches ?? []).slice(0, 3).map((m) => ({
                            name: m.displayName || m.urn,
                            where: (m.ancestorPath ?? []).map((a) => a.displayName).join(' / '),
                        })),
                    })
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


export interface NodeRefPickerProps {
    value: NodeRef | null
    onChange: (next: NodeRef | null) => void
    placeholder?: string
    autoFocus?: boolean
    disabled?: boolean
}


export const NodeRefPicker: FC<NodeRefPickerProps> = ({
    value, onChange, placeholder = 'Country / United Kingdom — or paste a URN', autoFocus, disabled,
}) => {
    const [text, setText] = useState(() => refText(value))
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
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <input
                    type="text" value={text} placeholder={placeholder} autoFocus={autoFocus}
                    disabled={disabled} aria-label="Entity by name path or URN"
                    onChange={(e) => {
                        setText(e.target.value)
                        onChange(textToRef(e.target.value))
                    }}
                    className={cn(inputClass, 'flex-1 min-w-0 font-mono text-[12px]')}
                />
                <ResolutionBadge state={resolution} />
            </div>
            {resolution.status === 'done' && resolution.matches.length > 0 && (
                <ul className="flex flex-col gap-0.5 pl-1">
                    {resolution.matches.map((m, i) => (
                        <li key={i} className="text-[10.5px] text-ink-muted truncate">
                            {m.where ? <span className="text-ink-muted/70">{m.where} / </span> : null}
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
