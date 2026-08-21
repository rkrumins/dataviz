/**
 * Visual harness for the Analytics tabs.
 *
 * Renders the REAL tab components against a fixed document — no API, no
 * router data loading, no auth. It exists because the privacy postures are
 * unreachable by hand: seeing the strict view needs a second account with no
 * workspace bindings and two flags set a particular way, and seeing the
 * workspace-reporting view needs a third combination. The redaction work
 * shipped twice without anybody having looked at it.
 *
 *   npx vite --port 5199 --strictPort
 *   open http://localhost:5199/analytics-harness.html?fixture=strict&tab=overview
 *
 * `npm run harness:analytics` drives Chromium over every fixture × tab and
 * writes PNGs to .harness/.
 *
 * `&theme=dark` renders the dark palette — the chart colours are resolved in
 * JavaScript from the preferences store, so a dark screenshot is the only way
 * to check the validated dark steps actually land.
 */
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { usePreferencesStore } from '../store/preferences'
import { ANALYTICS_FIXTURES, type AnalyticsFixtureName } from './analyticsFixtures'
import { OverviewTab } from '../components/analytics/OverviewTab'
import { GrowthTab } from '../components/analytics/GrowthTab'
import { EngagementTab } from '../components/analytics/EngagementTab'
import { ContentTab } from '../components/analytics/ContentTab'
import { HealthTab } from '../components/analytics/HealthTab'
import { WorkspacesTab } from '../components/analytics/WorkspacesTab'
import { RedactionNotice } from '../components/analytics/Redacted'
import type { AnalyticsRangeSelection } from '../services/analyticsService'

const params = new URLSearchParams(window.location.search)
const fixtureName = (params.get('fixture') ?? 'privileged') as AnalyticsFixtureName
const tab = params.get('tab') ?? 'overview'
const dark = params.get('theme') === 'dark'

const RANGE: AnalyticsRangeSelection = { kind: 'preset', days: 14 }

function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)

    // The charts resolve their palette from this store, not from a CSS class,
    // so the store is what a dark screenshot has to move.
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
        document.body.style.background =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--nx-bg-canvas').trim() || '#fff'
    }, [setTheme])

    const { summary, rows } = ANALYTICS_FIXTURES[fixtureName]
    const common = { data: summary, range: RANGE, isStale: false }

    return (
        <MemoryRouter>
            <div className="min-h-screen bg-canvas p-6">
                <div className="mx-auto max-w-[1600px] space-y-5">
                    <p className="text-[11px] font-mono text-ink-muted">
                        fixture={fixtureName} · tab={tab} · theme={dark ? 'dark' : 'light'}
                    </p>
                    {summary.redaction && (
                        <RedactionNotice redaction={summary.redaction} />
                    )}
                    {tab === 'overview' && (
                        <OverviewTab {...common} onWorkspaceClick={() => {}} />
                    )}
                    {tab === 'growth' && <GrowthTab {...common} />}
                    {tab === 'engagement' && <EngagementTab {...common} />}
                    {tab === 'content' && <ContentTab {...common} />}
                    {tab === 'health' && <HealthTab {...common} />}
                    {tab === 'workspaces' && (
                        <WorkspacesTab
                            rows={rows} range={RANGE} isStale={false}
                            selectedId={null} onSelect={() => {}}
                        />
                    )}
                </div>
            </div>
        </MemoryRouter>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode><Harness /></StrictMode>,
)
