/** Where each assigned entity sits in the DATA (ancestors, root first) — provided by LayerStudio,
 *  read by the wizard's assigned rows to show "Placed · Part of …" as the canvas does. */
import { createContext } from 'react'
import type { AncestorRef } from '@/types/search'

export const PlacementPathsContext = createContext<ReadonlyMap<string, readonly AncestorRef[]>>(new Map())
