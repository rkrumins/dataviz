/**
 * `?discussion=<thread>&message=<message>` on a subject's page: the link a notification, or Copy
 * link, gives. It opens the questions drawer on that thread, scrolled to that message; the address
 * follows the thread the drawer shows, and closing the drawer takes both away again.
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SubjectKey } from '@/services/discussionsService'
import { useConversationsEnabled } from './useDiscussions'
import { useDiscussionsDrawer } from './drawerStore'

export function useDiscussionDeepLink(subject: (SubjectKey & { name?: string | null }) | null | undefined) {
    const on = useConversationsEnabled()
    const [params, setParams] = useSearchParams()
    const discussion = params.get('discussion')
    const message = params.get('message')
    const type = subject?.type
    const id = subject?.id
    const name = subject?.name

    // The address → the drawer.
    useEffect(() => {
        if (!on || !type || !id || !discussion) return
        const t = useDiscussionsDrawer.getState().target
        if (t?.subject.id === id && t.threadId === discussion && (t.messageId ?? null) === message) return
        useDiscussionsDrawer.getState().open({ subject: { type, id, name }, threadId: discussion, messageId: message })
    }, [on, type, id, name, discussion, message])

    // The drawer → the address: the thread it shows, nothing once it closes or goes back to the list.
    useEffect(() => {
        if (!on || !id) return
        return useDiscussionsDrawer.subscribe((s, before) => {
            const was = before.target?.subject.id === id ? before.target.threadId : null
            const now = s.target?.subject.id === id ? s.target.threadId : null
            if (was === now) return
            setParams((p) => {
                const next = new URLSearchParams(p)
                if (now) next.set('discussion', now)
                else next.delete('discussion')
                if (s.target?.messageId && now) next.set('message', s.target.messageId)
                else next.delete('message')
                return next
            }, { replace: true })
        })
    }, [on, id, setParams])
}
