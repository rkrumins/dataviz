/**
 * A page says what it is to the assistant — "this is the Acme workspace", "this is a guide page,
 * ask Help" — so a question asked here is about it, and the context chip names it. One line in
 * the page; withdrawn when the page goes. Views need none: the route says which view it is.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { AssistantPageKind, AssistantPersona } from '../api/types'
import { useAssistantStore } from '../store/assistantStore'

export interface AssistantPageRegistration {
    kind: AssistantPageKind
    id?: string
    title?: string
    workspaceId?: string
    dataSourceId?: string
    /** The persona the rail opens on here, while no conversation is in progress. */
    persona?: AssistantPersona
}

export function useAssistantPage(page: AssistantPageRegistration | null): void {
    const { pathname } = useLocation()
    const { kind, id, title, workspaceId, dataSourceId, persona } = page ?? {}
    useEffect(() => {
        if (!kind) return
        const registered = {
            path: pathname, kind,
            ...(id ? { id } : {}), ...(title ? { title } : {}),
            ...(workspaceId ? { workspaceId } : {}), ...(dataSourceId ? { dataSourceId } : {}),
            ...(persona ? { persona } : {}),
        }
        useAssistantStore.getState().setPage(registered)
        return () => useAssistantStore.getState().clearPage(registered)
    }, [pathname, kind, id, title, workspaceId, dataSourceId, persona])
}
