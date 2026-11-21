/**
 * "Ask about this" on a node: opens the questions drawer on the view the canvas shows, with the
 * ask box open and the question about that node. Undefined — so the menu offers nothing — while
 * questions are off, or where the canvas is not a saved view (a preview).
 */
import { useMemo } from 'react'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePersonaStore } from '@/store/persona'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { useConversationsEnabled } from './useDiscussions'
import { useDiscussionsDrawer } from './drawerStore'

export function useAskAboutNode(): ((nodeId: string) => void) | undefined {
    const on = useConversationsEnabled()
    const viewId = useViewExecutionContext()?.viewId ?? null
    return useMemo(() => {
        if (!on || !viewId) return undefined
        return (nodeId: string) => {
            const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId || n.data?.urn === nodeId)
            const urn = node?.data?.urn || nodeId
            const name = useSchemaStore.getState().schema?.views.find((v) => v.id === viewId)?.name ?? null
            useDiscussionsDrawer.getState().open({
                subject: { type: 'view', id: viewId, name },
                entity: { id: urn, label: resolveEntityName(node?.data, usePersonaStore.getState().mode, urn) },
                compose: true,
            })
        }
    }, [on, viewId])
}
