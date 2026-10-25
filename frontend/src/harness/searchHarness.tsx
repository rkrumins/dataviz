/**
 * Visual harness for Advanced Search.
 *
 * Renders the REAL `SearchMapPanel` — its own session, so the real runner,
 * counts and pickers all run — against `searchBackend`, an in-memory
 * catalog answering the search endpoints. No API, no auth, no canvas: a
 * plain region stands in for the canvas, so the panel sits where it does
 * in a View. Every state a person can reach is a URL away, so each can be
 * looked at — the only way to judge a layout, a popover or dark mode.
 *
 *   npm run harness
 *   open http://localhost:5199/search-harness.html?fixture=form&theme=dark
 *
 * `npm run harness:search` drives Chromium over every fixture and writes
 * PNGs to .harness/.
 *
 *   fixture    a named state from `SEARCH_FIXTURES` (default `empty`)
 *   theme      `dark` for the dark palette
 *   persona    `technical` for the Technical persona (default business)
 *   width      the panel's width in px (default 480)
 *   latency    ms every request waits, to see the loading states
 *   intro      show the first-run tip pointing at Search Studio
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { SEARCH_INTRO_KEY } from '../components/canvas/search/panel/guidance/searchIntro'
import { SearchMapPanel } from '../components/canvas/search/SearchMapPanel'
import { ProviderOverride } from '../providers/GraphProviderContext'
import { RemoteGraphProvider } from '../providers/RemoteGraphProvider'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { useSchemaStore } from '../store/schema'
import { useSearchStore } from '../store/searchStore'
import type { WorkspaceSchema } from '../types/schema'
import { searchFetch, type FakeFetchOptions } from './searchBackend'
import { ENTITY_TYPES, HARNESS_VIEW_ID, LAYERS, SEARCH_FIXTURES } from './searchFixtures'


const params = new URLSearchParams(window.location.search)
const fixtureName = params.get('fixture') ?? 'empty'
const fixture = SEARCH_FIXTURES[fixtureName] ?? SEARCH_FIXTURES.empty
const dark = params.get('theme') === 'dark'
const persona = params.get('persona') === 'technical' ? 'technical' : 'business'
const width = Number(params.get('width') ?? 480)
const latency = Number(params.get('latency') ?? 0)
const intro = params.has('intro')


// Every animation lands on its end state at once: a screenshot taken on
// Chromium's virtual clock otherwise catches the panel mid-spring.
MotionGlobalConfig.skipAnimations = true

// The browser state the panel reads at mount — set before the first render.
try {
    localStorage.setItem('advanced-search:panel-width', String(width))
    if (fixture.editorMode) localStorage.setItem('synodic.advancedSearch.editorMode', fixture.editorMode)
    else localStorage.removeItem('synodic.advancedSearch.editorMode')
    if (intro) localStorage.removeItem(SEARCH_INTRO_KEY)
    else localStorage.setItem(SEARCH_INTRO_KEY, '1')
} catch { /* a private window: the panel's defaults apply */ }

usePersonaStore.setState({ mode: persona })

useSchemaStore.setState({
    activeViewId: HARNESS_VIEW_ID,
    schema: {
        id: 'harness', name: 'Harness', version: '1',
        entityTypes: ENTITY_TYPES.map((t) => ({
            id: t.id, name: t.name, pluralName: t.pluralName,
            visual: { icon: t.icon, color: t.color, shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
            fields: [], hierarchy: {}, behavior: {},
        })),
        relationshipTypes: [],
        views: [{
            id: HARNESS_VIEW_ID, name: 'Enterprise lineage',
            content: {}, filters: {}, entityOverrides: {}, isDefault: true, isPublic: false, createdBy: 'harness',
            layout: { referenceLayout: { layers: LAYERS.map((l) => ({ id: l.id, name: l.name })) } },
        }],
        defaultViewId: HARNESS_VIEW_ID,
        containmentEdgeTypes: ['CONTAINS'],
        lineageEdgeTypes: ['TRANSFORMS'],
    } as unknown as WorkspaceSchema,
} as never)



/** A provider whose every request is answered by the harness's catalog. */
const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
Object.assign(provider, {
    fetch: (path: string, opts?: FakeFetchOptions) => searchFetch(path, opts, latency),
})

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })


function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])
    // The draft goes in after the panel has mounted: its runner clears the
    // store when it unmounts, which StrictMode makes it do once on mount.
    // A parent's effect runs after its children's, so this lands last.
    useEffect(() => {
        useSearchStore.getState().clear()
        if (fixture.draft) useSearchStore.getState().commitDraft(fixture.draft)
    }, [])

    return (
        <MemoryRouter>
            <QueryClientProvider client={queryClient}>
                <ProviderOverride value={{
                    provider, isLoading: false, error: null, scopeKind: 'ready',
                    workspaceId: 'ws-harness', dataSourceId: 'ds-harness',
                    providerReady: true, providerVersion: 1,
                } as never}>
                    <div className="fixed inset-0 flex flex-col bg-canvas-base text-ink">
                        <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-glass-border text-xs text-ink-muted">
                            <span className="font-display font-semibold text-ink">Enterprise lineage</span>
                            <span className="font-mono">fixture={fixtureName} · {persona} · {dark ? 'dark' : 'light'}</span>
                            <span className="truncate">{fixture.note}</span>
                        </div>
                        <div data-harness-canvas-row className="relative flex-1 min-h-0 flex">
                            <SearchMapPanel open viewId={HARNESS_VIEW_ID} onClose={() => {}} />
                            <div className="flex-1 bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]" />
                        </div>
                    </div>
                </ProviderOverride>
            </QueryClientProvider>
        </MemoryRouter>
    )
}


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Harness />
    </StrictMode>,
)
