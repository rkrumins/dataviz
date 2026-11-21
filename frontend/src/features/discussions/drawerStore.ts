/**
 * The questions drawer: which subject it is open on, and where in it the reader is — the list
 * (filtered to a node, or with the ask box open) or one thread (scrolled to a message).
 *
 * One drawer for the whole app, mounted once in the shell (`DiscussionsDrawerHost`), opened from
 * anywhere with `useDiscussionsDrawer.getState().open(...)`: a view's Questions button, a canvas
 * row's question mark, "Ask about this" on a node, a link from the Inbox.
 */
import { create } from 'zustand'
import { useCanvasStore } from '@/store/canvas'
import type { SubjectKey } from '@/services/discussionsService'

/** A node on the canvas a question is about. */
export interface DrawerEntity {
    id: string
    label: string
}

export interface DrawerSubject extends SubjectKey {
    /** Shown under the drawer's title until the server names it. */
    name?: string | null
}

export interface DrawerOpenOptions {
    subject: DrawerSubject
    /** Open on this thread rather than the list. */
    threadId?: string | null
    /** Scroll to, and light up, this message of it. */
    messageId?: string | null
    /** The list filtered to questions about this node — and a new one asked about it. */
    entity?: DrawerEntity | null
    /** Open with the ask box open. */
    compose?: boolean
    /** People to ask, besides the routes (a profile's "Ask a question"). */
    recipients?: string[]
}

export interface DrawerTarget {
    subject: DrawerSubject
    threadId: string | null
    messageId: string | null
    entity: DrawerEntity | null
    compose: boolean
    recipients: string[]
}

interface DrawerState {
    target: DrawerTarget | null
    open: (options: DrawerOpenOptions) => void
    close: () => void
    /** Into a thread, or (null) back to the list. */
    showThread: (threadId: string | null, messageId?: string | null) => void
    setEntity: (entity: DrawerEntity | null) => void
    setCompose: (compose: boolean) => void
}

export const useDiscussionsDrawer = create<DrawerState>((set) => ({
    target: null,
    open: (o) => set({
        target: {
            subject: o.subject,
            threadId: o.threadId ?? null,
            messageId: o.messageId ?? null,
            entity: o.entity ?? null,
            compose: !!o.compose,
            recipients: o.recipients ?? [],
        },
    }),
    close: () => set({ target: null }),
    showThread: (threadId, messageId = null) => set((s) => (s.target
        ? { target: { ...s.target, threadId, messageId, compose: threadId ? false : s.target.compose } }
        : s)),
    setEntity: (entity) => set((s) => (s.target ? { target: { ...s.target, entity } } : s)),
    setCompose: (compose) => set((s) => (s.target ? { target: { ...s.target, compose, recipients: compose ? s.target.recipients : [] } } : s)),
}))

/**
 * Close the drawer and show the node on the canvas: selected (never toggled off, as a second
 * click on a selected node would), pulsed where it is drawn, and a drawn row of the Context or
 * Hierarchy view scrolled to the middle. Selecting alone does not scroll, and a row the
 * virtualizer has not drawn has no element to scroll to — it is still selected, with its details.
 */
export function showNodeOnCanvas(urn: string) {
    useDiscussionsDrawer.getState().close()
    requestAnimationFrame(() => {
        const canvas = useCanvasStore.getState()
        const id = canvas.nodes.find((n) => n.id === urn || n.data?.urn === urn)?.id ?? urn
        if (!(canvas.selectedNodeIds.length === 1 && canvas.selectedNodeIds[0] === id)) canvas.selectNode(id)
        canvas.pulseNode(id)
        const row = document.getElementById(`layer-node-${id}`) ?? document.getElementById(`hierarchy-node-${id}`)
        row?.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' })
    })
}
