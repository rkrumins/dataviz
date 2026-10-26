/**
 * SentenceBuilder — the guided way to build a query: the query as a
 * sentence whose parts are tokens to click, with each line's count on the
 * right, so the matches can be watched narrowing as clauses are added.
 *
 *   Find [Datasets]                                         1,240 ▇▇▇▇
 *     that [feed] [a Chart] [within 1–3 hops]                  86 ▇
 *       ↳ that [is inside] [Finance]
 *     and [are tagged] [#PII]                                   3 ▏
 *     + and…
 *
 * It edits the same draft the Form cards do, through the same two writes —
 * ``onSeed`` for a value, ``onCommit`` for a change of shape — so undo and
 * the auto-run behave exactly as they do there.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { useSearchStore } from '@/store/searchStore'
import type { NodeRef, Predicate } from '@/types/search'

import type { ValueSuggester } from '../../builder/useDiscovery'
import type { LayerOption } from '../layerOptions'
import { useLiveCounts } from '../counts/liveCounts'
import { useClauseCounts } from '../counts/useClauseCounts'
import { layoutQueryMap } from '../map/layoutQueryMap'
import { QueryMap } from '../map/QueryMap'
import { RescueNote } from '../rescue/RescueFixes'
import { useRescue } from '../rescue/useRescue'
import type { CodeKind } from '../vocabulary/filterKinds'

import {
    buildSentence,
    duplicateAt,
    firstBlankToken,
    getAt,
    insertAt,
    listedClauses,
    prependAt,
    setAt,
    withCombine,
    withSubject,
    wrapAt,
    type Path,
    type SentenceLine,
} from './clauseModel'
import { ClauseLine, type LineCount } from './ClauseLine'
import { SentenceContext, type SentenceContextValue } from './sentenceContext'
import { useAnnouncement } from './useAnnouncement'


export interface SentenceBuilderProps {
    viewId: string
    predicate: Predicate | null
    onSeed: (next: Predicate | null) => void
    onCommit: (next: Predicate | null) => void
    discovery: {
        allKeys: string[]
        keysByEntityType: Record<string, string[]>
        tagValues: string[]
        getValueSamples: (key: string) => unknown[]
        suggestValues?: ValueSuggester
    }
    knownEntityTypes: string[]
    /** The types this view holds, most common first. */
    presentEntityTypes: string[]
    discoveredLayers: LayerOption[]
    isRunning?: boolean
    onSubmit?: () => void
    onOpenAdvanced?: () => void
    onOpenCode?: (kind: CodeKind) => void
    /** Switch to Code for what a sentence can't show. */
    onEditInCode: () => void
}


const typeCondition = (types: string[]): Predicate => ({ kind: 'entityType', op: 'in', values: types })

export function SentenceBuilder({
    viewId, predicate, onSeed, onCommit, discovery, knownEntityTypes, presentEntityTypes,
    discoveredLayers, isRunning = false, onSubmit, onOpenAdvanced, onOpenCode, onEditInCode,
}: SentenceBuilderProps) {
    const sentence = useMemo(() => buildSentence(predicate), [predicate])
    const counts = useClauseCounts(viewId, predicate)
    const [, setLiveCounts] = useLiveCounts()
    const [openToken, setOpenToken] = useState<string | null>(null)

    // Handlers read the latest draft through a ref, so they — and the
    // memoised lines holding them — stay the same while values are typed.
    const draftRef = useRef(predicate)
    useLayoutEffect(() => { draftRef.current = predicate }, [predicate])
    // A clause just added opens for its first value once it has a line.
    const added = useRef<Predicate | null>(null)

    const actions = useMemo(() => ({
        replace: (path: Path, next: Predicate, structural = false) => {
            const updated = setAt(draftRef.current, path, next)
            if (structural) onCommit(updated)
            else onSeed(updated)
        },
        remove: (path: Path) => { setOpenToken(null); onCommit(setAt(draftRef.current, path, null)) },
        add: (into: Path, p: Predicate) => {
            added.current = p
            onCommit(insertAt(draftRef.current, into, p))
        },
        duplicate: (path: Path) => onCommit(duplicateAt(draftRef.current, path)),
        wrap: (path: Path, op: 'or' | 'not') => onCommit(wrapAt(draftRef.current, path, op)),
        setSubject: (types: string[]) => {
            const draft = draftRef.current
            // Other types for the subject are a value; a subject added or
            // dropped is a change of shape.
            if (listedClauses(draft).subject && types.length) onSeed(withSubject(draft, types))
            else onCommit(withSubject(draft, types))
        },
        setCombine: (op: 'and' | 'or') => onCommit(withCombine(draftRef.current, op)),
        setRelativeTypes: (line: Extract<SentenceLine, { kind: 'relation' }>, types: string[]) => {
            const r = line.relative
            if (r.kind === 'types') {
                if (types.length) onSeed(setAt(draftRef.current, r.path, typeCondition(types)))
                else onCommit(setAt(draftRef.current, r.path, null))
            } else if (types.length) {
                onCommit(prependAt(draftRef.current, [...line.path, { where: true }], typeCondition(types)))
            }
        },
        setRelativeRefs: (line: Extract<SentenceLine, { kind: 'relation' }>, refs: NodeRef[]) => {
            const r = line.relative
            if (r.kind !== 'names') return
            const named: Predicate = { kind: 'is', refs }
            onSeed(setAt(draftRef.current, r.path, r.orInside
                ? { kind: 'group', op: 'or', children: [named, { kind: 'related', axis: 'ancestor', where: named }] }
                : named))
        },
        editInCode: onEditInCode,
        onOpenCode,
        setOpenToken,
    }), [onSeed, onCommit, onEditInCode, onOpenCode])

    const ctx = useMemo<SentenceContextValue>(() => ({
        ...actions,
        editorProps: {
            discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit, onOpenAdvanced,
            activeEntityTypes: sentence.lines[0].kind === 'subject' ? sentence.lines[0].types : [],
        },
        presentTypes: presentEntityTypes.length ? presentEntityTypes : knownEntityTypes,
        isRunning,
        combine: sentence.combine,
    }), [actions, discovery, knownEntityTypes, discoveredLayers, isRunning, onSubmit, onOpenAdvanced,
        sentence, presentEntityTypes])

    // Open the clause just added for its first value.
    useEffect(() => {
        const p = added.current
        if (!p) return
        added.current = null
        const line = sentence.lines.find((l) => ((l.kind === 'clause' || l.kind === 'relation') && l.predicate === p)
            || (l.kind === 'relation' && l.relative.kind === 'types' && getAt(predicate, l.relative.path) === p))
        if (!line) return
        const suffix = line.kind === 'relation' ? (line.predicate === p ? 'verb' : 'rel') : '0'
        // After the menu that added it has closed and given focus back.
        const t = setTimeout(() => setOpenToken(`${line.key}:${suffix}`), 30)
        return () => clearTimeout(t)
    }, [sentence, predicate])

    // A recipe with something to fill in opens there. Taken when it
    // opens, so a re-run effect can't spend the request on nothing.
    useEffect(() => {
        if (!useSearchStore.getState().pendingOpenBlank) return
        const key = firstBlankToken(sentence)
        if (!key) return
        const t = setTimeout(() => {
            if (useSearchStore.getState().consumeOpenBlank()) setOpenToken(key)
        }, 30)
        return () => clearTimeout(t)
    }, [sentence])

    // Each line's count: how many match once it is added (in an all-of
    // query), or alone (any-of). The subject line shows its own total.
    const lineCounts = useMemo(() => {
        const out = new Map<string, LineCount>()
        const shownOf = (top: number) => {
            const c = counts.clauses[top]
            if (!c) return null
            return sentence.combine === 'or' ? c.alone : (c.cumulative ?? c.alone)
        }
        let scale = 0
        for (const line of sentence.lines) {
            if (line.topIndex === null) continue
            scale = Math.max(scale, shownOf(line.topIndex)?.count ?? 0)
        }
        for (const line of sentence.lines) {
            if (line.topIndex === null) continue
            const c = counts.clauses[line.topIndex]
            out.set(line.key, {
                shown: shownOf(line.topIndex), alone: c?.alone ?? null, reason: c?.reason ?? null,
                status: counts.status, scale,
            })
        }
        return out
    }, [counts, sentence])

    // Each listed clause with the lines below it is one block: pointing
    // at it, or focus inside it, shows where to add to it.
    const blocks = useMemo(() => {
        const out: SentenceLine[][] = []
        for (const line of sentence.lines) {
            if (out.length === 0 || line.topIndex !== null || line.key === 'root+') out.push([line])
            else out[out.length - 1].push(line)
        }
        return out
    }, [sentence])

    // The shape is drawn once there is one: a relationship, or a route.
    const map = useMemo(() => layoutQueryMap(sentence), [sentence])
    // Where the matches run out, and the way back — before anything runs.
    const rescue = useRescue(viewId, predicate, counts)
    // Said once the counts settle, for anyone not watching them.
    const total = counts.status === 'done' ? counts.total : null
    const announcement = useAnnouncement(!total ? ''
        : total.complete && total.count === 0 && rescue.line
            ? `Nothing matches: the matches run out at “${rescue.line}”.`
            : `${total.count.toLocaleString()}${total.complete ? '' : ' or more'} ${total.count === 1 ? 'match' : 'matches'}.`)

    return (
        <SentenceContext.Provider value={ctx}>
            <div className="flex flex-col gap-3">
                {map.nodes.length > 1 && <QueryMap map={map} counts={counts} onOpen={setOpenToken} />}
                {/* Where the numbers would be, why they aren't. */}
                {counts.status === 'off' && predicate && (
                    <button type="button" onClick={() => setLiveCounts(true)}
                            className={cn(
                                'self-end -mb-2 rounded-md px-1.5 py-0.5 text-2xs text-ink-muted',
                                'hover:bg-accent-lineage/10 hover:text-accent-lineage',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                            )}>
                        Counts off · <span className="font-medium text-accent-lineage">Turn on</span>
                    </button>
                )}
                <div role="list" aria-label="The query, as a sentence" className="flex flex-col">
                    {blocks.map((block) => (
                        <div key={block[0].key} role="none" className="group/block flex flex-col">
                            {block.map((line) => (
                                <ClauseLine key={line.key} line={line} count={lineCounts.get(line.key) ?? null}
                                            openToken={openToken?.startsWith(`${line.key}:`) ? openToken : null} />
                            ))}
                            {rescue.clause !== null && block[0].topIndex === rescue.clause && (
                                <div role="none" className="py-1 pl-3.5">
                                    <RescueNote rescue={rescue} onApply={onCommit} />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                <p aria-live="polite" className="sr-only">{announcement}</p>
            </div>
        </SentenceContext.Provider>
    )
}
