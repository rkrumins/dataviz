/**
 * ReadsAs — a query read back in the Sentence builder's own words, as one
 * line: what a question will become before it is applied.
 *
 *   Find [Datasets] that [feed] [a Dashboard] within 1–3 hops that are tagged [#Finance]
 */
import { Fragment, useMemo } from 'react'

import { useEntityVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { buildSentence, type SentenceLine } from '../sentence/clauseModel'
import { TypeIcon } from '../sentence/editors'
import { relationWords, toRuns } from '../sentence/lineWords'
import { useTypeName } from '../sentence/useTypeName'
import { leafSegments } from '../vocabulary/sentenceGrammar'


const PILL = 'inline-flex items-center gap-1 rounded-md border px-1 leading-5'

function EntityPill({ type, children }: { type?: string; children: string }) {
    const color = useEntityVisual(type ?? '').color
    return type
        ? (
            <span className={cn(PILL, 'font-medium')}
                  style={{ color, backgroundColor: `${color}1a`, borderColor: `${color}33` }}>
                <TypeIcon type={type} />{children}
            </span>
        )
        : <span className={cn(PILL, 'border-dashed border-ink-muted/50 text-ink-muted')}>{children}</span>
}

const VERB = cn(PILL, 'border-accent-lineage/20 bg-accent-lineage/10 font-medium text-accent-lineage')
const VALUE = cn(PILL, 'border-glass-border bg-black/[0.04] text-ink dark:bg-white/[0.06]')

const GROUP_WORDS = { and: 'all of', or: 'any of', not: 'none of' } as const


export function ReadsAs({ predicate }: { predicate: Predicate }) {
    const sentence = useMemo(() => buildSentence(predicate), [predicate])
    const typeName = useTypeName()

    const line = (l: SentenceLine) => {
        const lead = l.lead.replace(/^↳\s*/, '')
        switch (l.kind) {
            case 'subject':
                return (
                    <>
                        <span className="font-semibold text-ink">Find</span>{' '}
                        <EntityPill type={l.types[0]}>
                            {l.types.length ? l.types.map((t) => typeName(t, true)).join(' or ') : 'anything'}
                        </EntityPill>
                    </>
                )
            case 'clause':
                return (
                    <>
                        {lead && <span className="text-ink-muted">{lead} </span>}
                        {toRuns(leafSegments(l.predicate, l.many)).map((r, i) => (r.slot && r.tone !== 'phrase'
                            ? <Fragment key={i}><span className={VALUE}>{r.text}</span></Fragment>
                            : <Fragment key={i}>{r.text}</Fragment>))}
                    </>
                )
            case 'relation': {
                const w = relationWords(l, typeName)
                const type = l.relative.kind === 'types' ? l.relative.types[0] : undefined
                return (
                    <>
                        {lead && <span className="text-ink-muted">{lead} </span>}
                        <span className={VERB}>{w.verb}</span>{' '}
                        {l.relative.kind === 'names'
                            ? <span className={VALUE}>{w.relative}</span>
                            : <EntityPill type={type}>{w.relative}</EntityPill>}
                        {w.reach && <span className="text-ink-muted"> {w.reach}</span>}
                    </>
                )
            }
            case 'group':
                return <span className="text-ink-muted">{lead} match {GROUP_WORDS[l.op]}:</span>
            default:
                return null
        }
    }

    return (
        <span className="leading-7 text-ink">
            {sentence.lines.filter((l) => l.kind !== 'add' && l.kind !== 'code').map((l, i) => (
                <Fragment key={l.key}>{i > 0 && ' '}{line(l)}</Fragment>
            ))}
        </span>
    )
}
