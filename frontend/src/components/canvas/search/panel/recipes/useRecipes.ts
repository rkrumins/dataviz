import { useMemo } from 'react'

import { useTypeName } from '../sentence/useTypeName'
import { recipesFor, type Recipe, type RecipeView } from './recipes'


/** The recipes a view can use, in its own words. */
export function useRecipes(types: RecipeView['types'], tags: RecipeView['tags'], keys: RecipeView['keys'],
    layers: RecipeView['layers']): Recipe[] {
    const typeName = useTypeName()
    return useMemo(() => recipesFor({ types, tags, keys, layers }, typeName), [types, tags, keys, layers, typeName])
}
