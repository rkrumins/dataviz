/**
 * OntologyHierarchyPreview — "what does this ontology actually look like?"
 *
 * The Entities step used to describe the semantic layer only in numbers ("2
 * entity types · 3 relationships"), which tells you nothing about the SHAPE the
 * view will open with. This renders the containment chain the graph nests by:
 *
 *     Roots ──HAS──▶ Node ↺
 *      16          2,083,200
 *
 * Deliberately not a mini graph canvas: it's the containment spine, the edge
 * that walks it, and how many instances live at each level.
 *
 * Self-containment is real (a Node nests inside a Node in the Solidatus
 * ontology), so the walk is depth-guarded and a self-nesting type is marked
 * rather than expanded forever.
 */

import { useMemo } from 'react'
import { ChevronRight, Repeat } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HierarchyPreviewEntityType {
    id: string
    name: string
    pluralName?: string
    visual?: { icon?: string; color?: string }
    hierarchy?: { level?: number; canContain?: string[] }
}

export interface HierarchyPreviewRelationship {
    id: string
    name: string
    isContainment?: boolean
    sourceTypes?: string[]
    targetTypes?: string[]
}

export interface HierarchyLevelType {
    id: string
    name: string
    /** This type can contain ITSELF — the chain would never terminate. */
    selfNesting: boolean
}

export interface HierarchyLevel {
    depth: number
    types: HierarchyLevelType[]
    /** Containment edge walked from the previous level into this one. */
    viaLabel?: string
}

/** Deepest chain we'll draw — a guard, not a real-world limit. */
const MAX_DEPTH = 8

// ─── Pure builder (unit-tested) ─────────────────────────────────────────────

/**
 * Walk `canContain` breadth-first from the ontology's roots.
 *
 * A type is placed at the SHALLOWEST level it appears at and never revisited,
 * so cycles (A contains B contains A) terminate instead of looping.
 */
export function buildHierarchyLevels(
    entityTypes: HierarchyPreviewEntityType[],
    relationshipTypes: HierarchyPreviewRelationship[] = [],
    rootEntityTypes: string[] = [],
    containmentEdgeTypes: string[] = [],
): HierarchyLevel[] {
    if (entityTypes.length === 0) return []

    const byId = new Map(entityTypes.map(et => [et.id, et]))
    const canContain = (id: string) => byId.get(id)?.hierarchy?.canContain ?? []

    // Roots, most-trustworthy source first: the schema's own list, then an
    // explicit level 0, then "never contained by anything else".
    let rootIds = rootEntityTypes.filter(id => byId.has(id))
    if (rootIds.length === 0) {
        rootIds = entityTypes.filter(et => et.hierarchy?.level === 0).map(et => et.id)
    }
    if (rootIds.length === 0) {
        const contained = new Set(entityTypes.flatMap(et => et.hierarchy?.canContain ?? []))
        rootIds = entityTypes.filter(et => !contained.has(et.id)).map(et => et.id)
    }
    if (rootIds.length === 0) return []

    /** Which containment edge walks parents → children? */
    const labelFor = (parentIds: string[], childIds: string[]): string | undefined => {
        const match = relationshipTypes.find(rt =>
            rt.isContainment
            && rt.sourceTypes?.some(s => parentIds.includes(s))
            && rt.targetTypes?.some(t => childIds.includes(t)),
        )
        if (match) return match.name || match.id
        // Single-containment ontologies (the common case) don't need the lookup.
        if (containmentEdgeTypes.length === 1) return containmentEdgeTypes[0]
        return undefined
    }

    const levels: HierarchyLevel[] = []
    const placed = new Set<string>()
    let current = rootIds

    for (let depth = 0; depth < MAX_DEPTH && current.length > 0; depth++) {
        const types: HierarchyLevelType[] = current.map(id => ({
            id,
            name: byId.get(id)?.name ?? id,
            selfNesting: canContain(id).includes(id),
        }))
        current.forEach(id => placed.add(id))

        const next = [...new Set(current.flatMap(canContain))].filter(id => byId.has(id) && !placed.has(id))

        levels.push({
            depth,
            types,
            viaLabel: depth === 0 ? undefined : levels[depth - 1]
                ? labelFor(levels[depth - 1].types.map(t => t.id), current)
                : undefined,
        })

        current = next
    }

    return levels
}

// ─── Component ──────────────────────────────────────────────────────────────

function LevelCard({
    type,
    entityType,
    count,
}: {
    type: HierarchyLevelType
    entityType?: HierarchyPreviewEntityType
    count?: number
}) {
    const color = entityType?.visual?.color ?? '#94a3b8'

    return (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 shrink-0">
            <div
                className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 text-white shadow-sm"
                style={{ backgroundColor: color }}
            >
                <DynamicIcon name={entityType?.visual?.icon ?? 'Box'} className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-1">
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate" title={type.name}>
                        {type.name}
                    </span>
                    {type.selfNesting && (
                        <span
                            className="inline-flex items-center text-violet-500 shrink-0"
                            title={`${type.name} can nest inside another ${type.name}`}
                        >
                            <Repeat className="w-3 h-3" />
                        </span>
                    )}
                </div>
                <span className="block text-[10px] leading-tight text-slate-400 tabular-nums">
                    {count === undefined ? '— entities' : `${count.toLocaleString()} ${count === 1 ? 'entity' : 'entities'}`}
                </span>
            </div>
        </div>
    )
}

export function OntologyHierarchyPreview({
    entityTypes,
    relationshipTypes,
    containmentEdgeTypes,
    rootEntityTypes,
    countFor,
    className,
}: {
    entityTypes: HierarchyPreviewEntityType[]
    relationshipTypes: HierarchyPreviewRelationship[]
    containmentEdgeTypes: string[]
    rootEntityTypes: string[]
    /** Instance count for a type — undefined when the graph didn't report one. */
    countFor: (typeId: string) => number | undefined
    className?: string
}) {
    const levels = useMemo(
        () => buildHierarchyLevels(entityTypes, relationshipTypes, rootEntityTypes, containmentEdgeTypes),
        [entityTypes, relationshipTypes, rootEntityTypes, containmentEdgeTypes],
    )
    const byId = useMemo(() => new Map(entityTypes.map(et => [et.id, et])), [entityTypes])

    if (entityTypes.length === 0) return null

    // Flat ontology: worth saying out loud — it tells the user the view won't nest.
    if (levels.length < 2) {
        return (
            <p className={cn('text-[11px] text-slate-400 dark:text-slate-500', className)}>
                No containment hierarchy — these entity types sit side by side.
            </p>
        )
    }

    return (
        <div className={className}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                How it nests
            </p>
            {/* Wide ontologies scroll rather than wrapping into a broken chain. */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 custom-scrollbar">
                {levels.map((level, i) => (
                    <div key={level.depth} className="flex items-center gap-1.5 shrink-0">
                        {i > 0 && (
                            <div className="flex items-center gap-1 shrink-0 text-slate-300 dark:text-slate-600">
                                <ChevronRight className="w-3.5 h-3.5" />
                                {level.viaLabel && (
                                    <span className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700/60 text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                        {level.viaLabel}
                                    </span>
                                )}
                                <ChevronRight className="w-3.5 h-3.5" />
                            </div>
                        )}
                        <div className="flex items-center gap-1.5 shrink-0">
                            {level.types.slice(0, 3).map(t => (
                                <LevelCard
                                    key={t.id}
                                    type={t}
                                    entityType={byId.get(t.id)}
                                    count={countFor(t.id)}
                                />
                            ))}
                            {level.types.length > 3 && (
                                <span className="text-[10px] font-medium text-slate-400 shrink-0">
                                    +{level.types.length - 3}
                                </span>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

export default OntologyHierarchyPreview
