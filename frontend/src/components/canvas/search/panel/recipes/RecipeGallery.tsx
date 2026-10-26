/**
 * RecipeGallery — ready-made questions, each with how many it finds here.
 * The empty query card starts with a few, one per intent, and opens out to
 * all of them; the Library and an idle Search Studio show them all, by
 * intent. Counts are rough, asked once the gallery comes into sight; a
 * recipe with something to fill in says so instead.
 */
import { ArrowRight, ChevronDown } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { Skeleton } from '@/components/ui/Skeleton'
import { useSharedIntersectionObserver } from '@/hooks/useSharedIntersectionObserver'
import { cn } from '@/lib/utils'

import { countId } from '../counts/clauseItems'
import { useCounts, type CountState, type CountsStatus } from '../counts/useCounts'
import { RECIPE_INTENTS, startingRecipes, type Recipe } from './recipes'


const STARTERS = 5
const NOWHERE = { current: null }

/** Seen once it has been in sight — at once where nothing can tell. */
function useSeen(ref: React.RefObject<Element | null>): boolean {
    const observable = typeof IntersectionObserver === 'function'
    const seen = useSharedIntersectionObserver(observable ? ref : NOWHERE)
    return !observable || seen
}


export function RecipeGallery({ viewId, recipes, variant, filter = '', onPick }: {
    viewId: string | null
    recipes: readonly Recipe[]
    /** ``starters``: a few to begin with, opening out to all. */
    variant: 'starters' | 'all'
    /** Only the recipes whose words hold this. */
    filter?: string
    onPick: (recipe: Recipe) => void
}) {
    const ref = useRef<HTMLDivElement>(null)
    const seen = useSeen(ref)
    const [expanded, setExpanded] = useState(false)
    const all = variant === 'all' || expanded

    const shown = useMemo(() => {
        if (!all) return startingRecipes(recipes, STARTERS)
        const q = filter.trim().toLowerCase()
        return q ? recipes.filter((r) => `${r.title} ${r.description}`.toLowerCase().includes(q)) : recipes
    }, [all, recipes, filter])
    const items = useMemo(() => shown.filter((r) => !r.blank)
        .map((r) => ({ id: countId(r.predicate), predicate: r.predicate })), [shown])
    const { counts, status } = useCounts(viewId, items, { rough: true, enabled: seen })

    if (recipes.length === 0) return null
    const row = (r: Recipe, detail: string) => (
        <RecipeRow key={r.id} recipe={r} detail={detail} onPick={onPick} status={status}
                   count={r.blank ? null : counts.get(countId(r.predicate)) ?? null} />
    )
    const intentTitle = (id: Recipe['intent']) => RECIPE_INTENTS.find((i) => i.id === id)?.title ?? ''

    return (
        <div ref={ref} className="flex flex-col gap-1.5">
            {variant === 'starters' && (
                <div className="flex items-center justify-between px-1">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                        Start from a recipe
                    </span>
                    <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
                            className="inline-flex items-center gap-0.5 rounded-md px-1 text-xs text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                        {expanded ? 'Fewer' : `All ${recipes.length}`}
                        <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} aria-hidden />
                    </button>
                </div>
            )}
            {!all ? (
                <div role="list" aria-label="Recipes to start from" className="flex flex-col">
                    {shown.map((r) => row(r, intentTitle(r.intent)))}
                </div>
            ) : shown.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-ink-muted">No recipe matches “{filter}”.</p>
            ) : (
                RECIPE_INTENTS.map((intent) => {
                    const mine = shown.filter((r) => r.intent === intent.id)
                    if (mine.length === 0) return null
                    return (
                        <section key={intent.id} aria-label={intent.title} className="flex flex-col">
                            <h3 className="flex items-baseline gap-2 px-1 pb-0.5 pt-2">
                                <span className="text-xs font-semibold text-ink">{intent.title}</span>
                                <span className="text-2xs text-ink-muted">{intent.question}</span>
                            </h3>
                            <div role="list" className="flex flex-col">
                                {mine.map((r) => row(r, r.description))}
                            </div>
                        </section>
                    )
                })
            )}
        </div>
    )
}


function RecipeRow({ recipe, detail, count, status, onPick }: {
    recipe: Recipe
    detail: string
    count: CountState | null
    status: CountsStatus
    onPick: (recipe: Recipe) => void
}) {
    return (
        <div role="listitem">
            <button type="button" onClick={() => onPick(recipe)}
                    className="group/recipe flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.05]">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
                    <DynamicIcon name={recipe.icon} className="h-3.5 w-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-ink">{recipe.title}</span>
                    <span className="truncate text-2xs text-ink-muted">{detail}</span>
                </span>
                <RecipeCount blank={recipe.blank} count={count} status={status} />
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-accent-lineage opacity-0 transition-opacity group-hover/recipe:opacity-100 group-focus-visible/recipe:opacity-100" aria-hidden />
            </button>
        </div>
    )
}


function RecipeCount({ blank, count, status }: { blank: boolean; count: CountState | null; status: CountsStatus }) {
    if (blank) return <span className="shrink-0 rounded-md border border-dashed border-accent-lineage/40 px-1.5 text-2xs text-accent-lineage">fill in</span>
    if (!count) return status === 'counting' ? <Skeleton className="h-4 w-8 shrink-0 rounded-md" /> : null
    if (count.complete && count.count === 0) return <span className="shrink-0 text-xs text-ink-muted">none</span>
    return (
        <span className="shrink-0 text-xs font-medium tabular-nums text-ink">
            {count.count.toLocaleString()}{count.complete ? '' : '+'}
        </span>
    )
}
