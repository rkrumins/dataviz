/**
 * "Ask about this" on a node: opens the questions drawer on the view the canvas shows, with the
 * ask box open and the question about that node. Undefined — so the menu offers nothing — while
 * questions are off, or where the canvas is not a saved view (a preview).
 */
import { useMemo } from 'react'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import type { LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useConversationsEnabled } from './useDiscussions'
import { useDiscussionsDrawer } from './drawerStore'
import { anchorOf, completeAnchorPath } from './anchorOf'

/** `resolve` finds a node the canvas store doesn't hold (a Context View trace card). */
export function useAskAboutNode(resolve?: (id: string) => LineageNode | null): ((nodeId: string) => void) | undefined {
    const on = useConversationsEnabled()
    const viewId = useViewExecutionContext()?.viewId ?? null
    const provider = useGraphProviderIfAvailable()
    return useMemo(() => {
        if (!on || !viewId) return undefined
        return (nodeId: string) => {
            const entity = anchorOf(nodeId, { resolve })
            const name = useSchemaStore.getState().schema?.views.find((v) => v.id === viewId)?.name ?? null
            useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: viewId, name }, entity, compose: true })
            completeAnchorPath(entity, provider)
        }
    }, [on, viewId, resolve, provider])
}
