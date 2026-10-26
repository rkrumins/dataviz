/**
 * The predicate the results on show answer, set by the results pane — what
 * a hit row's "How it matches" reads. Null outside one.
 */
import { createContext } from 'react'

import type { Predicate } from '@/types/search'


export const ShownQueryContext = createContext<Predicate | null>(null)
