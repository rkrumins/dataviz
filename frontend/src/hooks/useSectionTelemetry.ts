/**
 * Records which part of the app someone moves to — once per section change, not
 * per page — so People analytics can say where a person spends their time, not
 * only which views they open.
 *
 * Sections are the sidebar's (`tabForPath`); the server keeps only the names it
 * knows. Moving between two pages of the same section records nothing, and a
 * path that is no section (a profile, the docs) leaves the last one standing.
 */
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

import { tabForPath } from '@/store/navigation'
import { recordEvent } from '@/services/telemetryService'

const WORKSPACE_PATH = /^\/workspaces\/([^/]+)/

export function sectionVisit(pathname: string, last: string | null): { section: string; workspaceId?: string } | null {
    const section = tabForPath(pathname)
    if (!section || section === last) return null
    const ws = WORKSPACE_PATH.exec(pathname)?.[1]
    return { section, ...(ws ? { workspaceId: decodeURIComponent(ws) } : {}) }
}

export function useSectionTelemetry(enabled: boolean): void {
    const { pathname } = useLocation()
    const last = useRef<string | null>(null)
    useEffect(() => {
        if (!enabled) return
        const visit = sectionVisit(pathname, last.current)
        if (!visit) return
        last.current = visit.section
        recordEvent('app.section', { section: visit.section },
            visit.workspaceId ? { workspaceId: visit.workspaceId } : {})
    }, [pathname, enabled])
}
