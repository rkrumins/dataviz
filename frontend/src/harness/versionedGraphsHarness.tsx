/**
 * Visual harness for Admin → Versioned graphs: the REAL section — its own queries, editor and
 * dialogs — against `versionedGraphsFetch`, an in-memory settings API. No backend, no auth. Every
 * state is a URL away, in both themes and at any width; `scripts/versioned-graphs-shot.mjs` drives
 * it in Chromium (staging, Review, the drawer) and writes PNGs to .harness/.
 *
 *   npm run harness
 *   open http://localhost:5199/versioned-graphs-harness.html?tab=settings&lens=business&theme=dark
 *
 *   tab        overview | settings | history (default overview)
 *   lens       business | operator (the persona the page opens on)
 *   scenario   ok | loading | error | empty | readonly | workspace-admin | fork | conflict
 *   drawer     1: a graph's settings drawer, open
 *   theme      `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../styles/globals.css'
import { AdminVersionedGraphs } from '../components/admin/AdminVersionedGraphs'
import { GraphSettingsDrawer } from '../components/admin/AdminVersionedGraphs/GraphSettingsDrawer'
import { NotificationStack } from '../components/ui/notifications'
import { useAuthStore } from '../store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { GRAPH, WS, versionedGraphsFetch, type Scenario } from './versionedGraphsFixtures'

const params = new URLSearchParams(window.location.search)
const tab = params.get('tab') ?? 'overview'
const scenario = (params.get('scenario') ?? 'ok') as Scenario
const dark = params.get('theme') === 'dark'
const drawer = params.get('drawer') === '1'

// Every animation lands on its end state at once: a screenshot otherwise catches a panel mid-slide.
MotionGlobalConfig.skipAnimations = true
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'
document.head.appendChild(still)

window.fetch = versionedGraphsFetch(scenario)
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never)
useAuthStore.setState({ permissions: { sid: 'harness', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
usePersonaStore.setState({ mode: params.get('lens') === 'business' ? 'business' : 'technical' })

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

export function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [open, setOpen] = useState(drawer)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])
    return (
        <div className="min-h-screen bg-canvas text-ink">
            <MemoryRouter initialEntries={[`/admin/versioned-graphs?tab=${tab}${window.location.hash}`]}>
                <Routes>
                    <Route path="/admin/versioned-graphs" element={<AdminVersionedGraphs />} />
                    <Route path="*" element={<p className="p-8 text-sm">Left the section.</p>} />
                </Routes>
                {drawer && <GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open={open} onOpenChange={setOpen} label="Sales lineage" />}
            </MemoryRouter>
            <NotificationStack />
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <Harness />
        </QueryClientProvider>
    </StrictMode>,
)
