/**
 * ViewRecipes — every recipe for a view, read from what it holds, for a
 * surface that doesn't already know: the Library, an idle Search Studio.
 * (The query card's own starters share the card's reading.)
 */
import { useMemo } from 'react'

import { Skeleton } from '@/components/ui/Skeleton'
import { useSchemaStore } from '@/store/schema'

import { useDiscovery } from '../../builder/useDiscovery'
import { entityTypesInView, useViewLayerOptions } from '../layerOptions'
import { RecipeGallery } from './RecipeGallery'
import type { Recipe } from './recipes'
import { useRecipes } from './useRecipes'


export function ViewRecipes({ viewId, filter, onPick }: {
    viewId: string
    filter?: string
    onPick: (recipe: Recipe) => void
}) {
    const discovery = useDiscovery(viewId)
    const schemaTypes = useSchemaStore((s) => s.schema?.entityTypes)
    const known = useMemo(() => (schemaTypes ?? []).map((t) => t.id), [schemaTypes])
    const types = useMemo(() => entityTypesInView(discovery.discovery?.labels, known), [discovery.discovery, known])
    const layers = useViewLayerOptions(discovery.getValueSamples)
    const recipes = useRecipes(types, discovery.tagValues, discovery.allKeys, layers)

    if (discovery.isInitialLoading) {
        return (
            <div className="flex flex-col gap-1.5" aria-busy="true">
                {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
            </div>
        )
    }
    return <RecipeGallery viewId={viewId} recipes={recipes} variant="all" filter={filter} onPick={onPick} />
}
