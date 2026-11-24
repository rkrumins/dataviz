/**
 * People analytics harness — the real People tab and person page, on fixtures,
 * with no API behind them. `?view=tab|workspace|person|day|feed&theme=dark`.
 *
 * The service object is patched rather than the network mocked: every component,
 * hook and query key on the page is the one that ships.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import '../styles/globals.css'
import { usePreferencesStore } from '../store/preferences'
import { peopleActivityService } from '../services/peopleActivityService'
import type { AnalyticsRangeSelection } from '../services/analyticsService'
import { PeopleTab } from '../components/analytics/people/PeopleTab'
import { PersonActivityPage } from '../pages/PersonActivityPage'
import {
    PEOPLE_FIXTURES, PERSON_ID, personCalendar, personDay, personDoc, personFeed,
} from './peopleFixtures'

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'tab'
const dark = params.get('theme') === 'dark'

peopleActivityService.roster = async (_range, q) =>
    q.workspaceId ? PEOPLE_FIXTURES.workspaceAdmin : PEOPLE_FIXTURES.privileged
peopleActivityService.person = async () => personDoc()
peopleActivityService.calendar = async () => personCalendar()
peopleActivityService.day = async (_id, d) => personDay(d)
peopleActivityService.events = async () => personFeed()

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })

function TabHarness({ workspaceId }: { workspaceId: string | null }) {
    const [range, setRange] = useState<AnalyticsRangeSelection>({ kind: 'preset', days: 30 })
    return (
        <div className="mx-auto max-w-[1400px] p-6">
            <PeopleTab
                range={range} onRangeChange={setRange} workspaceId={workspaceId}
                scopes={workspaceId ? undefined : [{ id: null, name: 'All workspaces' }, { id: 'ws_atlas', name: 'Atlas' }]}
            />
        </div>
    )
}

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background =
            getComputedStyle(document.documentElement).getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])

    const yesterday = personDay().day
    const entry = view === 'person' ? `/analytics/people/${PERSON_ID}`
        : view === 'day' ? `/analytics/people/${PERSON_ID}?day=${yesterday}`
        : view === 'feed' ? `/analytics/people/${PERSON_ID}?tab=activity`
        : '/'
    return (
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[entry]}>
                <Routes>
                    <Route path="/" element={<TabHarness workspaceId={view === 'workspace' ? 'ws_atlas' : null} />} />
                    <Route path="/analytics/people/:userId" element={<div className="relative h-screen"><PersonActivityPage /></div>} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
