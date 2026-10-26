/**
 * RelationDiagram — a relationship drawn the way it reads: this entity, the
 * edges between, and the relatives at the far end —
 *
 *   ( ⌖ This ) ──── Produces ────▶ ( ◆ Dataset )
 *                     1 step          at least one
 *
 * The arrow points the way the edges run: a relative that feeds this one
 * points at it. The edge says what it follows — lineage, any link, edge
 * types by name — or, for the hierarchy, "inside" / "contains" without an
 * arrow. The far end shows the entity types its conditions name, the
 * entities a name points at, or "Anything". A picture for people who don't
 * read queries; the edge opens the steps, edges and direction.
 */
import { CircleDashed, Crosshair, Filter, MapPin } from 'lucide-react'
import type { FC, ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useEntityVisual } from '@/hooks/useEntityVisual'
import { useRelationshipTypes } from '@/store/schema'
import type { Predicate, RelatedPredicate } from '@/types/search'

import { TypeIcon } from './sentence/editors'
import { useTypeName } from './sentence/useTypeName'
import { axisMeta, farEndTypes, hopRange, linkDirection, refLabel, throughOf } from './relations'
import { edgeTypeName } from './vocabulary/edgeWords'


/** What the hierarchy's edge says, per axis. */
const TREE_WORDS: Partial<Record<RelatedPredicate['axis'], string>> = {
    parent: 'directly inside', ancestor: 'inside', root: 'sits under',
    child: 'directly contains', descendant: 'contains',
}

const COUNT_WORDS: Record<string, string> = {
    gte: 'at least', gt: 'more than', eq: 'exactly', lte: 'at most', lt: 'fewer than', neq: 'other than',
}


/** The relatives a sentence names: "at least one Dataset", "no Column",
 *  "only Columns", "at least 3 Columns" — or the named entities themselves. */
function farPhrase(p: RelatedPredicate, what: { one: string; many: string }, named: boolean): string {
    if (p.count) return `${COUNT_WORDS[p.count.op ?? 'gte']} ${p.count.value} ${p.count.value === 1 ? what.one : what.many}`
    if (p.quantifier === 'none') return `no ${what.one}`
    if (p.quantifier === 'all') return `only ${what.many}`
    return named ? what.one : `at least one ${what.one}`
}

/** How many of the relatives the relationship asks for, in words. */
function quantityWords(p: RelatedPredicate): string {
    if (p.count) return `${COUNT_WORDS[p.count.op ?? 'gte']} ${p.count.value}`
    return p.quantifier === 'none' ? 'none of them' : p.quantifier === 'all' ? 'every one' : 'at least one'
}


export const RelationDiagram: FC<{
    value: RelatedPredicate
    /** Open the steps, edges and direction. */
    onEdit?: () => void
}> = ({ value, onEdit }) => {
    const relationshipTypes = useRelationshipTypes()
    const typeName = useTypeName()
    const meta = axisMeta(value.axis)
    const through = throughOf(value)
    const [lo, hi] = hopRange(value)

    // The edge: what it follows, which way, how far.
    let label: string
    let color: string | undefined
    if (!meta.lineage) label = TREE_WORDS[value.axis] ?? value.axis
    else if (through === 'types') {
        const names = (value.edgeTypes ?? []).map(edgeTypeName)
        label = names.length ? names.join(' or ') : 'edge types to pick'
        color = relationshipTypes.find((t) => t.id.toUpperCase() === value.edgeTypes?.[0]?.toUpperCase())
            ?.visual?.strokeColor
    } else if (through === 'links') label = 'any link'
    else label = value.axis === 'neighbor' ? 'lineage' : 'feeds'
    const direction = meta.lineage ? linkDirection(value.axis) : null
    const reach = meta.lineage
        ? (lo === hi ? `${hi} step${hi === 1 ? '' : 's'}` : `${lo}–${hi} steps`)
        : !meta.hops ? '' : !value.maxHops ? (lo > 1 ? `${lo}+ levels` : 'any depth')
            : lo === hi ? `${hi} level${hi === 1 ? '' : 's'}` : `${lo}–${hi} levels`

    // The far end: what its conditions name.
    const types = farEndTypes(value.where as Predicate | undefined)
    const several = value.quantifier === 'all' || (!!value.count && value.count.value !== 1)
    const named = value.where?.kind === 'is' ? value.where.refs.map(refLabel) : []
    const farLabel = named.length ? named.join(', ')
        : types.length ? types.map((t) => typeName(t, several)).join(' or ')
            : value.where ? 'Something' : 'Anything'
    const quantity = quantityWords(value)
    const none = value.quantifier === 'none'

    const verb = through === 'links' ? 'links to' : label
    const far = farPhrase(value, {
        one: named.length ? named.join(', ') : types.length ? types.map((t) => typeName(t)).join(' or ')
            : value.where ? 'entity that matches' : 'entity',
        many: named.length ? named.join(', ') : types.length ? types.map((t) => typeName(t, true)).join(' or ')
            : value.where ? 'entities that match' : 'entities',
    }, named.length > 0)
    // Always from this entity's side, so the verb agrees whatever the far end's number.
    const incoming = through === 'lineage' ? 'is fed by' : through === 'links' ? 'is linked from'
        : `has incoming ${label} from`
    const said = !meta.lineage ? `This ${meta.verb[0]} ${far}`
        : direction === 'in' ? `This ${incoming} ${far}`
            : direction === 'both' ? `This is linked to ${far} through ${label}`
                : `This ${verb} ${far}`
    const sentence = reach ? `${said}, ${reach}` : said

    return (
        <div role="img" aria-label={sentence}
             className="flex items-center gap-1.5 rounded-xl border border-glass-border/60 bg-gradient-to-r from-accent-lineage/[0.07] via-transparent to-transparent px-2.5 py-2.5">
            <Node icon={<Crosshair className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />}
                  label="This" sub="what you find" />
            <button type="button" onClick={onEdit} disabled={!onEdit} tabIndex={-1} aria-hidden
                    className={cn('group flex min-w-[64px] flex-1 flex-col items-center gap-0.5 px-1',
                        onEdit && 'cursor-pointer')}>
                <span className={cn('max-w-full truncate rounded-md px-1.5 text-[11px] font-semibold',
                    meta.lineage ? 'text-ink' : 'text-ink-secondary',
                    onEdit && 'group-hover:bg-accent-lineage/10')}>
                    {label}
                </span>
                <Line direction={direction} tone={!meta.lineage ? 'tree' : through} color={color} />
                {reach && <span className="text-[10px] tabular-nums text-ink-muted">{reach}</span>}
            </button>
            <FarNode types={types} named={named.length > 0} label={farLabel}
                     sub={quantity} rose={none} conditions={!!value.where && !types.length && !named.length} />
        </div>
    )
}


const Node: FC<{ icon: ReactNode; label: string; sub?: string; color?: string; dashed?: boolean;
    rose?: boolean }> = ({ icon, label, sub, color, dashed, rose }) => (
    <div className={cn(
        'flex min-w-0 max-w-[42%] shrink-0 flex-col rounded-xl border bg-canvas-elevated px-2.5 py-1.5 shadow-sm',
        dashed ? 'border-dashed border-glass-border' : 'border-glass-border',
    )} style={color ? { borderLeftWidth: 3, borderLeftColor: color } : undefined}>
        <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className={cn('min-w-0 truncate text-[12.5px] font-semibold', dashed ? 'text-ink-muted' : 'text-ink')}>
                {label}
            </span>
        </span>
        {sub && (
            <span className={cn('truncate text-[10px]', rose ? 'font-medium text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
                {sub}
            </span>
        )}
    </div>
)


function FarNode({ types, named, label, sub, rose, conditions }: {
    types: string[]; named: boolean; label: string; sub: string; rose: boolean; conditions: boolean
}) {
    const visual = useEntityVisual(types[0] ?? '')
    const icon = named ? <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
        : types.length ? <TypeIcon type={types[0]} />
            : conditions ? <Filter className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                : <CircleDashed className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
    return <Node icon={icon} label={label} sub={sub} rose={rose}
                 color={types.length ? visual.color : undefined} dashed={!types.length && !named && !conditions} />
}


/** The edge's line: solid for lineage and for named types (in the type's
 *  colour), dashed for any link, dotted for the hierarchy — with arrowheads
 *  the way the edges run. */
function Line({ direction, tone, color }: {
    direction: 'out' | 'in' | 'both' | null; tone: 'lineage' | 'links' | 'types' | 'tree'; color?: string
}) {
    const head = (flip: boolean) => (
        <svg width="7" height="8" viewBox="0 0 7 8" aria-hidden data-arrowhead
             className={cn('shrink-0', flip && 'rotate-180')}>
            <path d="M0 0 L7 4 L0 8 z" fill="currentColor" />
        </svg>
    )
    return (
        <span className={cn('flex w-full items-center',
            tone === 'lineage' ? 'text-accent-lineage' : tone === 'tree' ? 'text-ink-muted/70' : 'text-ink-secondary')}
              style={color ? { color } : undefined}>
            {(direction === 'in' || direction === 'both') && head(true)}
            <span className={cn('flex-1 border-t-2 border-current',
                tone === 'links' && 'border-dashed', tone === 'tree' && 'border-dotted')} />
            {(direction === 'out' || direction === 'both') && head(false)}
        </span>
    )
}
