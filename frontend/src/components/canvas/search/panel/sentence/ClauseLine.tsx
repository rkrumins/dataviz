/**
 * ClauseLine — one line of a sentence: its lead words, its clause as
 * tokens, and on the right how many entities the query matches once this
 * line is added (the lines read top to bottom as the matches narrow).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Code2, Copy, CircleSlash, Info, MoreHorizontal, Split, Trash2 } from 'lucide-react'
import { Fragment, memo, useContext, useMemo, type ReactNode } from 'react'

import { HoverTip } from '@/components/ui/HoverTip'
import { useEntityVisual } from '@/hooks/useEntityVisual'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { ConditionEditor } from '../ConditionRow'
import { NodeRefList } from '../NodeRefPicker'
import { RelationContext } from '../relationContext'
import { RelationshipEditor } from '../RelationshipEditor'
import { axisMeta } from '../relations'
import { filterKindById } from '../vocabulary/filterKinds'
import { leafSegments, type Slot } from '../vocabulary/sentenceGrammar'
import { UNCOUNTABLE_WORDS, type Uncountable } from '../counts/countable'
import type { CountsStatus, CountState } from '../counts/useCounts'

import type { SentenceLine } from './clauseModel'
import { CombinePicker, GroupOpPicker, ShapePicker, TypeIcon, TypePicker } from './editors'
import { AddClauseMenu } from './AddClauseMenu'
import { relationWords, toRuns } from './lineWords'
import { useSentence } from './sentenceContext'
import { Token, type TokenTone } from './Token'
import { useTypeName } from './useTypeName'


export interface LineCount {
    /** What the query matches once this line is added. */
    shown: CountState | null
    /** What this line matches by itself, when that differs. */
    alone: CountState | null
    reason: Uncountable | null
    status: CountsStatus
    /** The largest count shown, for the bars. */
    scale: number
}


const SLOT_TITLE: Partial<Record<Slot, string>> = {
    text: 'What text', types: 'Which types', tags: 'Which tags', layer: 'Which layer',
    key: 'Which property', value: 'Compared with', refs: 'Which entities', hops: 'How far',
    count: 'How many', edge: 'Through which edges', source: 'From', target: 'To',
}

/** The palette's name for a clause's kind — the popover's heading. */
const KIND_ID: Record<string, string> = {
    text: 'text-name', entityType: 'entity-type', tag: 'tag', hasProperty: 'has-property',
    property: 'property', isRoot: 'no-upstream', isLeaf: 'no-downstream', isOrphan: 'no-lineage',
    hasIncoming: 'has-upstream', hasOutgoing: 'has-downstream', is: 'is-named', path: 'path',
    descendantOf: 'inside-named',
}
function kindTitle(p: Predicate): string {
    const kind = p.kind ? filterKindById(KIND_ID[p.kind] ?? '') : undefined
    return kind?.label.replace(/…$/, '') ?? 'Condition'
}

const SHAPE_KINDS = new Set(['isRoot', 'isLeaf', 'isOrphan', 'hasIncoming', 'hasOutgoing'])
/** Kinds no builder edits: their tokens hand over to Code. */
const CODE_KINDS = new Set(['withinHops', 'degree'])


// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

export const ClauseLine = memo(function ClauseLine({ line, count, openToken }: {
    line: SentenceLine
    count: LineCount | null
    /** The open token's key, when it is on this line. */
    openToken: string | null
}) {
    const ctx = useSentence()
    const typeName = useTypeName()
    const subjectColor = useEntityVisual(line.kind === 'subject' ? line.types[0] ?? '' : '').color
    const tokenState = (suffix: string) => {
        const key = `${line.key}:${suffix}`
        return { open: openToken === key, onOpenChange: (o: boolean) => ctx.setOpenToken(o ? key : null) }
    }

    let body: ReactNode
    switch (line.kind) {
        case 'subject': {
            const label = line.types.length ? line.types.map((t) => typeName(t, true)).join(' or ') : 'anything'
            body = (
                <Token {...tokenState('types')} tone={line.types.length ? 'entity' : 'gap'}
                       color={line.types.length ? subjectColor : undefined}
                       icon={line.types[0] ? <TypeIcon type={line.types[0]} /> : undefined}
                       ariaLabel={`What the query finds: ${label}`} title="Find which types"
                       editor={<TypePicker value={line.types} onChange={ctx.setSubject} types={ctx.presentTypes} autoFocus />}
                       className="text-base font-semibold">
                    {label}
                </Token>
            )
            break
        }
        case 'clause':
            body = <ClauseTokens line={line} tokenState={tokenState} />
            break
        case 'relation':
            body = <RelationTokens line={line} tokenState={tokenState} />
            break
        case 'group': {
            const words = line.op === 'and' ? 'all of' : line.op === 'or' ? 'any of' : 'none of'
            body = (
                <>
                    <span className="text-ink-muted">match</span>
                    <Token {...tokenState('op')} tone="verb" ariaLabel={`How these combine: ${words}`}
                           title="How these combine" width="sm"
                           editor={<GroupOpPicker value={line.op}
                               onChange={(op) => ctx.replace(line.path, { ...line.predicate, op }, true)} />}>
                        {words}
                    </Token>
                    <span className="text-ink-muted">these:</span>
                </>
            )
            break
        }
        case 'add':
            return (
                // Adding inside a clause is offered where the pointer or
                // focus is; adding to the query, always.
                <div className={cn('py-0.5', line.key !== 'root+' && cn(
                    'opacity-0 transition-opacity focus-within:opacity-100 has-[[data-state=open]]:opacity-100',
                    'group-hover/block:opacity-100 group-focus-within/block:opacity-100',
                ))} style={{ paddingLeft: line.depth * 14 }}>
                    <AddClauseMenu joiner={line.joiner} relationDepth={line.relationDepth}
                                   onAdd={(p) => ctx.add(line.into, p)} onOpenCode={ctx.onOpenCode}
                                   disabled={ctx.isRunning} />
                </div>
            )
        case 'code':
            body = (
                <>
                    <span className="text-ink-muted">nested deeper than a sentence shows —</span>
                    <button type="button" onClick={ctx.editInCode}
                            className="inline-flex items-center gap-1 text-sm text-accent-lineage hover:underline">
                        <Code2 className="h-3.5 w-3.5" /> edit in Code
                    </button>
                </>
            )
            break
    }

    return (
        <div role="listitem" className="group/line flex items-start gap-2 rounded-lg py-0.5 pr-1 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
             style={{ paddingLeft: line.depth * 14 }}>
            <div className={cn('flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-ink',
                line.depth > 1 && 'border-l border-glass-border pl-2')}>
                {line.combines ? <CombineWords lead={line.lead} {...tokenState('join')} /> : line.lead && (
                    <span className={cn(line.kind === 'subject'
                        ? 'font-display text-base font-semibold text-ink' : 'text-ink-muted')}>{line.lead}</span>
                )}
                {body}
            </div>
            {count && <CountGutter count={count} />}
            {(line.kind === 'clause' || line.kind === 'relation' || line.kind === 'group') && (
                <LineMenu line={line} />
            )}
        </div>
    )
})


/** "and" / "or" leading a listed clause: a token that joins them all one
 *  way or the other ("or where": the word after stays words). */
function CombineWords({ lead, open, onOpenChange }: {
    lead: string
    open: boolean
    onOpenChange: (o: boolean) => void
}) {
    const ctx = useSentence()
    const [word, ...rest] = lead.split(' ')
    return (
        <>
            <Token open={open} onOpenChange={onOpenChange} tone="phrase" width="sm"
                   ariaLabel={`How the conditions combine: ${word}`} title="How the conditions combine"
                   editor={<CombinePicker value={ctx.combine}
                       onPick={(op) => { ctx.setOpenToken(null); if (op !== ctx.combine) ctx.setCombine(op) }} />}
                   className="text-ink-muted">
                {word}
            </Token>
            {rest.length > 0 && <span className="text-ink-muted">{rest.join(' ')}</span>}
        </>
    )
}


function ClauseTokens({ line, tokenState }: {
    line: Extract<SentenceLine, { kind: 'clause' }>
    tokenState: (suffix: string) => { open: boolean; onOpenChange: (o: boolean) => void }
}) {
    const ctx = useSentence()
    const runs = useMemo(() => toRuns(leafSegments(line.predicate, line.many)), [line.predicate, line.many])
    const p = line.predicate
    const editor = SHAPE_KINDS.has(p.kind ?? '')
        ? <ShapePicker value={p.kind} onPick={(next) => ctx.replace(line.path, next, true)} />
        : CODE_KINDS.has(p.kind ?? '')
            ? (
                <div className="flex flex-col items-start gap-2">
                    <p className="text-xs text-ink-muted">This condition is written in Code.</p>
                    <button type="button" onClick={ctx.editInCode}
                            className="inline-flex items-center gap-1 text-sm text-accent-lineage hover:underline">
                        <Code2 className="h-3.5 w-3.5" /> Edit in Code
                    </button>
                </div>
            )
            : <ConditionEditor {...ctx.editorProps} value={p} autoFocus
                               onChange={(next) => ctx.replace(line.path, next)} />
    return (
        <>
            {runs.map((run, i) => {
                if (!run.slot && run.tone !== 'cond') {
                    if (run.tone === 'em') return <strong key={i} className="font-semibold text-rose-500 dark:text-rose-300">{run.text}</strong>
                    if (run.tone === 'note') return <span key={i} className="text-ink-muted">{run.text}</span>
                    return run.text.trim() ? <span key={i} className="text-ink-muted">{run.text.trim()}</span> : <Fragment key={i} />
                }
                const title = run.slot === 'phrase' || !run.slot ? kindTitle(p) : SLOT_TITLE[run.slot] ?? kindTitle(p)
                return (
                    <Token key={i} {...tokenState(String(i))}
                           tone={(run.tone === 'cond' ? 'value' : run.tone) as TokenTone}
                           ariaLabel={`${title}: ${run.text}`} title={title}
                           width={SHAPE_KINDS.has(p.kind ?? '') ? 'md' : 'lg'} editor={editor}>
                        {run.text}
                    </Token>
                )
            })}
        </>
    )
}


function RelationTokens({ line, tokenState }: {
    line: Extract<SentenceLine, { kind: 'relation' }>
    tokenState: (suffix: string) => { open: boolean; onOpenChange: (o: boolean) => void }
}) {
    const ctx = useSentence()
    const relationCtx = useContext(RelationContext)
    const typeName = useTypeName()
    const p = line.predicate
    const relative = line.relative
    const relativeColor = useEntityVisual(relative.kind === 'types' ? relative.types[0] ?? '' : '').color
    const { verb, relative: relativeLabel, reach, via: viaText } = relationWords(line, typeName)
    // Named or typed, but not yet: a gap to fill.
    const relativeBlank = (relative.kind === 'names' && relative.refs.length === 0)
        || (relative.kind === 'types' && relative.types.length === 0)

    const nested = useMemo(() => ({ ...relationCtx, depth: line.relationDepth }), [relationCtx, line.relationDepth])
    const relationEditor = (
        <RelationContext.Provider value={nested}>
            <RelationshipEditor value={p} hideWhere
                                onChange={(next) => ctx.replace(line.path, next)}
                                discovery={ctx.editorProps.discovery}
                                knownEntityTypes={ctx.editorProps.knownEntityTypes}
                                discoveredLayers={ctx.editorProps.discoveredLayers}
                                isRunning={ctx.isRunning} onSubmit={ctx.editorProps.onSubmit} />
        </RelationContext.Provider>
    )
    const lineage = axisMeta(p.axis).lineage

    return (
        <>
            <Token {...tokenState('verb')} tone="verb" ariaLabel={`Relationship: ${verb}`}
                   title={axisMeta(p.axis).label} width="lg" editor={relationEditor}>
                {verb}
            </Token>
            <Token {...tokenState('rel')}
                   tone={relativeBlank ? 'gap' : relative.kind === 'types' ? 'entity' : relative.kind === 'names' ? 'value' : 'gap'}
                   color={relative.kind === 'types' ? relativeColor : undefined}
                   icon={relative.kind === 'types' && relative.types[0] ? <TypeIcon type={relative.types[0]} /> : undefined}
                   ariaLabel={`Which relatives: ${relativeLabel}`}
                   title={relative.kind === 'names' ? 'Which entities' : 'Which types'}
                   editor={relative.kind === 'names'
                       ? <NodeRefList value={relative.refs} autoFocus disabled={ctx.isRunning}
                                      onChange={(refs) => ctx.setRelativeRefs(line, refs)} />
                       : <TypePicker value={relative.kind === 'types' ? relative.types : []} autoFocus
                                     onChange={(types) => ctx.setRelativeTypes(line, types)} types={ctx.presentTypes} />}>
                {relativeLabel}
            </Token>
            {(reach || lineage) && (
                <Token {...tokenState('hops')} tone="phrase" title="How far" width="lg" editor={relationEditor}
                       ariaLabel={`How far: ${reach ?? 'directly'}`}>
                    {reach ?? 'directly'}
                </Token>
            )}
            {viaText && (
                <>
                    <span className="text-ink-muted">through edges where</span>
                    <Token {...tokenState('via')} tone="value" title="Through which edges" width="lg"
                           editor={relationEditor} ariaLabel={`Through edges where ${viaText}`}>
                        {viaText}
                    </Token>
                </>
            )}
        </>
    )
}


function CountGutter({ count }: { count: LineCount }) {
    if (count.status === 'unavailable' || count.status === 'off') return null
    if (count.reason) {
        return (
            <HoverTip label={UNCOUNTABLE_WORDS[count.reason]} className="inline-flex shrink-0">
                <span className="mt-1.5 inline-flex items-center text-ink-muted/70" aria-label={UNCOUNTABLE_WORDS[count.reason]}>
                    <Info className="h-3.5 w-3.5" />
                </span>
            </HoverTip>
        )
    }
    const shown = count.shown
    if (!shown) {
        return count.status === 'counting'
            ? <Skeleton className="mt-2 h-3 w-12 shrink-0 rounded" />
            : null
    }
    const pct = count.scale > 0 ? Math.max(3, Math.round((shown.count / count.scale) * 100)) : 0
    const text = `${shown.count.toLocaleString()}${shown.complete ? '' : '+'}`
    const zero = shown.complete && shown.count === 0
    const tip = count.alone && count.alone.count !== shown.count
        ? `${count.alone.count.toLocaleString()} match this line alone` : undefined
    const number = (
        <span className={cn('flex w-16 shrink-0 flex-col items-end gap-0.5 pt-1',
            !shown.complete && 'opacity-80')} aria-live="off">
            <span className={cn('text-xs font-medium tabular-nums',
                zero ? 'text-rose-500 dark:text-rose-400' : 'text-ink')}>{text}</span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                <span className={cn('block h-full rounded-full transition-[width] duration-300',
                    zero ? 'bg-rose-500/70' : 'bg-accent-lineage/70')} style={{ width: `${pct}%` }} />
            </span>
        </span>
    )
    return tip ? <HoverTip label={tip} className="inline-flex shrink-0">{number}</HoverTip> : number
}


function LineMenu({ line }: { line: Extract<SentenceLine, { kind: 'clause' | 'relation' | 'group' }> }) {
    const ctx = useSentence()
    const item = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink outline-none cursor-pointer data-[highlighted]:bg-black/[0.05] dark:data-[highlighted]:bg-white/[0.06]'
    return (
        <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="Line actions"
                        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:bg-black/[0.05] hover:text-ink focus-visible:opacity-100 group-hover/line:opacity-100 data-[state=open]:opacity-100 dark:hover:bg-white/[0.06]">
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4}
                                      className="z-50 min-w-[12rem] rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-2xl shadow-black/25">
                    <DropdownMenu.Item className={item} onSelect={() => ctx.duplicate(line.path)}>
                        <Copy className="h-3.5 w-3.5 text-ink-muted" /> Duplicate
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={item} onSelect={() => ctx.wrap(line.path, 'or')}>
                        <Split className="h-3.5 w-3.5 text-ink-muted" /> Match any of…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={item} onSelect={() => ctx.wrap(line.path, 'not')}>
                        <CircleSlash className="h-3.5 w-3.5 text-ink-muted" /> Exclude these
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />
                    <DropdownMenu.Item className={cn(item, 'text-rose-600 dark:text-rose-400')}
                                       onSelect={() => ctx.remove(line.path)}>
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    )
}

