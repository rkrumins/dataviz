/**
 * Visual harness for the AI assistant.
 *
 * Renders the REAL `AssistantRail` — its store, its stream reader, every card — beside a stand-in
 * canvas, against `aiBackend`, an in-memory service that streams scripted answers as server-sent
 * events. No API, no auth, no model. Every state is a URL away, so each can be looked at in
 * light and dark and at the rail's narrowest — the only way to judge a layout.
 *
 *   npm run harness
 *   open http://localhost:5199/ai-harness.html?fixture=impact&theme=dark
 *
 * `npm run harness:ai` drives Chromium over every fixture and writes PNGs to .harness/.
 *
 *   fixture    a named state from `AI_FIXTURES` (default `impact`)
 *   theme      `dark` for the dark palette
 *   width      the rail's width in px (default 440)
 *   persona    `business` for the Business view (default technical)
 *   delay      ms between streamed frames (default 40)
 *   scroll     `top` to hold the conversation at its start (the rail follows a stream down)
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { AssistantRail } from '../features/ai-assistant/components/AssistantRail'
import { useAssistantStore } from '../features/ai-assistant/store/assistantStore'
import { queryClient } from '../lib/queryClient'
import { useAuthStore } from '../store/auth'
import { registerCanvasActions } from '../store/canvasActionsBridge'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { useSchemaStore } from '../store/schema'
import type { WorkspaceSchema } from '../types/schema'
import { installAiBackend } from './aiBackend'
import { AI_FIXTURES, ENTITY_TYPES, HARNESS_VIEW_ID, HARNESS_VIEW_NAME } from './aiFixtures'


const params = new URLSearchParams(window.location.search)
const fixtureName = params.get('fixture') ?? 'impact'
const fixture = AI_FIXTURES[fixtureName] ?? AI_FIXTURES.impact
const dark = params.get('theme') === 'dark'
const width = Number(params.get('width') ?? 440)
const persona = params.get('persona') === 'business' ? 'business' : 'technical'
const delay = Number(params.get('delay') ?? 40)
const scrollTop = params.get('scroll') === 'top'

// A screenshot on Chromium's virtual clock would otherwise catch a card mid-entry.
MotionGlobalConfig.skipAnimations = true

installAiBackend(fixture, { frameDelayMs: delay })
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
usePersonaStore.setState({ mode: persona })
// An administrator, so the not-set-up state shows its way to Administration → AI.
useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
useAssistantStore.setState({ open: true, persona: fixture.persona ?? 'data', railWidth: width })
useSchemaStore.setState({
    activeViewId: HARNESS_VIEW_ID,
    schema: {
        id: 'harness', name: 'Harness', version: '1',
        entityTypes: ENTITY_TYPES.map((t) => ({
            id: t.id, name: t.name, pluralName: `${t.name}s`,
            visual: { icon: t.icon, color: t.color, shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
            fields: [], hierarchy: {}, behavior: {},
        })),
        relationshipTypes: [],
        views: [{
            id: HARNESS_VIEW_ID, name: HARNESS_VIEW_NAME, workspaceId: 'ws', dataSourceId: 'ds',
            content: {}, filters: {}, entityOverrides: {}, isDefault: true, isPublic: false, createdBy: 'harness', layout: {},
        }],
        defaultViewId: HARNESS_VIEW_ID,
        containmentEdgeTypes: ['CONTAINS'],
        lineageEdgeTypes: ['TRANSFORMS', 'PRODUCES', 'CONSUMES'],
    } as unknown as WorkspaceSchema,
} as never)


function Harness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [canvasSaid, setCanvasSaid] = useState<string | null>(null)
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])

    // A stand-in canvas on the bridge: it holds the fixture's selection, and says what the
    // assistant asked of it.
    useEffect(() => registerCanvasActions({
        viewId: HARNESS_VIEW_ID,
        reveal: (urn) => setCanvasSaid(`reveal ${urn}`),
        locateMany: (urns) => setCanvasSaid(`locate ${urns.length} entities`),
        startTrace: (urns, opts) => setCanvasSaid(`trace ${urns.join(', ')} ${opts?.direction ?? ''} ${opts?.depth ?? ''}`),
        runSearch: () => setCanvasSaid('run a search in Advanced Search'),
        openCypher: () => setCanvasSaid('open the Cypher tab'),
        getContext: () => ({
            viewId: HARNESS_VIEW_ID, viewName: HARNESS_VIEW_NAME, workspaceId: 'ws', dataSourceId: 'ds',
            selectedUrns: fixture.selected ?? [], focusUrn: fixture.selected?.[0] ?? null,
            focusName: fixture.selected?.length === 1 ? 'first_name' : undefined,
        }),
    }), [])

    // `scroll=top`: read from the start, as someone who scrolled back up would.
    useEffect(() => {
        if (!scrollTop) return
        const t = setInterval(() => {
            const log = document.querySelector('[role="log"]')?.parentElement
            if (log) log.scrollTop = 0
        }, 50)
        return () => clearInterval(t)
    }, [])

    // The fixture's question, asked as a launcher asks one: once the rail is open and ready.
    useEffect(() => {
        if (fixture.question) useAssistantStore.getState().openAssistant({ context: { prompt: fixture.question } })
    }, [])

    return (
        <MemoryRouter initialEntries={[`/views/${HARNESS_VIEW_ID}`]}>
            <QueryClientProvider client={queryClient}>
                <div className="fixed inset-0 flex flex-col bg-canvas text-ink">
                    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-glass-border bg-canvas-elevated px-4 text-xs text-ink-muted">
                        <span className="font-display font-semibold text-ink">{HARNESS_VIEW_NAME}</span>
                        <span className="font-mono">fixture={fixtureName} · {persona} · {dark ? 'dark' : 'light'} · {width}px</span>
                        <span className="truncate">{fixture.note}</span>
                        {canvasSaid && <span className="ml-auto font-mono text-accent-lineage">canvas: {canvasSaid}</span>}
                    </div>
                    <div className="flex min-h-0 flex-1 overflow-hidden">
                        <main className="relative flex-1 overflow-hidden bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]" />
                        <AssistantRail />
                    </div>
                </div>
            </QueryClientProvider>
        </MemoryRouter>
    )
}


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Harness />
    </StrictMode>,
)
