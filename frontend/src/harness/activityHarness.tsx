/**
 * Visual harness for the Activity explorer.
 *
 * Renders the REAL explorer against a fixed month of activity — no API, no
 * auth — so its states can be looked at: the insight band, the timeline with
 * folded repeats and reasons, the drawer, a workspace admin's narrower view,
 * and both palettes.
 *
 *   npx vite --port 5199 --strictPort
 *   open http://localhost:5199/activity-harness.html
 *
 * `&scope=workspace` renders a workspace admin's tab; `&theme=dark` the dark
 * palette; `&event=evt_0002` opens the drawer on that event; `&person=usr_7f3a`
 * puts that person in focus; `&kept=1` shows a range reaching back past what
 * the log keeps, scrolled to its end.
 */
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { usePreferencesStore } from '../store/preferences'
import { useAuthStore } from '../store/auth'
import { activityService, type ActivityScope } from '../services/activityService'
import { AdminActivity } from '../components/admin/AdminActivity'
import { ActivityExplorer } from '../components/activity/ActivityExplorer'
import { ACTIVITY_CATALOGUE, ACTIVITY_EVENTS, ACTIVITY_SUMMARY, activityDetail } from './activityFixtures'

const params = new URLSearchParams(window.location.search)
const dark = params.get('theme') === 'dark'
const workspace = params.get('scope') === 'workspace'
const openEvent = params.get('event')
const person = params.get('person')
const kept = params.get('kept') === '1'

// The network calls answer from the fixtures; everything else is the real code.
const ledger = {
    pending: 0, pendingCapped: false, lagSeconds: 4, backfilling: false, watermark: new Date().toISOString(),
    retentionDays: 730,
}
activityService.listEvents = async (scope) => ({
    events: ACTIVITY_EVENTS.map((e) => (scope.kind === 'workspace' ? { ...e, payload: null } : e)),
    nextCursor: kept ? null : 'more', ledger,
})
activityService.countNewer = async () => ({ count: 2, capped: false })
activityService.getSummary = async () => (kept
    ? {
        ...ACTIVITY_SUMMARY,
        window: { ...ACTIVITY_SUMMARY.window, keptFrom: new Date(Date.now() - 730 * 86_400_000).toISOString() },
        totals: {
            ...ACTIVITY_SUMMARY.totals,
            events: { ...ACTIVITY_SUMMARY.totals.events, previous: null, delta: null },
            people: { ...ACTIVITY_SUMMARY.totals.people, previous: null, delta: null },
            operations: { ...ACTIVITY_SUMMARY.totals.operations, previous: null, delta: null },
        },
    }
    : ACTIVITY_SUMMARY)
activityService.getCatalogue = async () => ACTIVITY_CATALOGUE
activityService.getEvent = async (scope, id) => {
    const detail = activityDetail(id)
    return scope.kind === 'workspace' ? { ...detail, event: { ...detail.event, payload: null } } : detail
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const WORKSPACE: ActivityScope = { kind: 'workspace', workspaceId: 'ws_fin' }

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background =
            getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])

    useEffect(() => {
        useAuthStore.setState({
            status: 'authenticated',
            isAuthenticated: true,
            permissionsStatus: 'ready',
            permissions: { sid: 'harness', global: ['system:audit:read'], ws: {} },
        } as never)
    }, [])

    return (
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[`/?${new URLSearchParams({
                ...(openEvent ? { act_event: openEvent } : {}),
                ...(person ? { act_person: person, act_role: 'actor' } : {}),
            })}`]}>
                <div className="min-h-screen bg-canvas">
                    {workspace ? (
                        <div className="mx-auto max-w-[1500px] p-6"><ActivityExplorer scope={WORKSPACE} /></div>
                    ) : (
                        <AdminActivity />
                    )}
                </div>
            </MemoryRouter>
        </QueryClientProvider>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode><Harness /></StrictMode>,
)
