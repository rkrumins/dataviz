/**
 * Visual harness for the AI assistant.
 *
 * Renders the REAL `AssistantRail` — its store, its stream reader, every card — and the REAL
 * launcher bubble, beside a stand-in canvas, against `aiBackend`, an in-memory service that
 * streams scripted answers as server-sent
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
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { FirstStepsChecklist } from '../components/canvas/context-view/FirstStepsChecklist'
import { useViewportReservation } from '../components/canvas/context-view/useBandReservation'
import { NotificationStack, useNotificationStore } from '../components/ui/notifications'
import { AssistantLauncher } from '../features/ai-assistant/components/AssistantLauncher'
import { AssistantRail } from '../features/ai-assistant/components/AssistantRail'
import { useAssistantPage } from '../features/ai-assistant/lib/useAssistantPage'
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
const viewName = fixture.viewName ?? HARNESS_VIEW_NAME

// A screenshot on Chromium's virtual clock would otherwise catch a card mid-entry.
MotionGlobalConfig.skipAnimations = true

installAiBackend(fixture, { frameDelayMs: delay })
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
usePersonaStore.setState({ mode: persona })
// An administrator, so the not-set-up state shows its way to Administration → AI.
useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
useAssistantStore.setState({
    open: !fixture.railClosed, persona: fixture.persona ?? 'data', railWidth: width,
    unread: !!fixture.unread, contextOpen: !!fixture.openContext,
})
if (fixture.notify) useNotificationStore.getState().add({ type: 'success', message: fixture.notify, durationMs: 600_000 })
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
            id: HARNESS_VIEW_ID, name: viewName, workspaceId: 'ws', dataSourceId: 'ds',
            content: {}, filters: {}, entityOverrides: {}, isDefault: true, isPublic: false, createdBy: 'harness', layout: {},
        }],
        defaultViewId: HARNESS_VIEW_ID,
        containmentEdgeTypes: ['CONTAINS'],
        lineageEdgeTypes: ['TRANSFORMS', 'PRODUCES', 'CONSUMES'],
    } as unknown as WorkspaceSchema,
} as never)


/** The page the fixture is on, as it registers itself (a workspace, a guide page). */
// eslint-disable-next-line react-refresh/only-export-components
function HarnessPage() {
    useAssistantPage(fixture.page ?? null)
    return null
}

/** A stand-in for the canvas's bottom-right dock (Data loads + Connections), reserving its height. */
// eslint-disable-next-line react-refresh/only-export-components
function StandInDock() {
    const ref = useRef<HTMLDivElement>(null)
    useViewportReservation(ref, '--canvas-dock-height')
    return (
        <div ref={ref} className="absolute bottom-2 right-4 z-40 flex h-[320px] w-80 flex-col gap-1.5">
            <div className="flex items-center justify-between rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 text-xs font-semibold text-ink shadow-lg">
                Data loads <span className="font-normal text-ink-muted">3 today</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-glass-border bg-canvas-elevated text-xs shadow-lg">
                <div className="border-b border-glass-border px-3 py-2 font-semibold text-ink">Connections</div>
                {['Transforms', 'Contains', 'Tagged with', 'Produces', 'Consumes'].map((n) => (
                    <div key={n} className="flex items-center justify-between px-3 py-1.5 text-ink-secondary"><span>{n}</span><span className="text-ink-muted">on</span></div>
                ))}
            </div>
        </div>
    )
}

// A Vite entry, not a module anyone imports: there is nothing to fast-refresh into.
// eslint-disable-next-line react-refresh/only-export-components
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
            viewId: HARNESS_VIEW_ID, viewName, workspaceId: 'ws', dataSourceId: 'ds',
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

    // The fixture's question, asked as a launcher asks one: once the rail is open and ready —
    // and, for a rail that starts folded, folded again once the question is on screen.
    useEffect(() => {
        if (!fixture.question) return
        useAssistantStore.getState().openAssistant({ context: { prompt: fixture.question } })
        if (!fixture.railClosed) return
        return useAssistantStore.subscribe((s) => { if (s.open && s.turns.length > 0) s.closeAssistant() })
    }, [])

    // `focusLauncher`: as a keyboard user arriving on it would — the pill opens, the tip shows.
    useEffect(() => {
        if (!fixture.focusLauncher) return
        const t = setTimeout(() => document.querySelector<HTMLElement>('button[aria-label^="Open the assistant"]')?.focus(), 300)
        return () => clearTimeout(t)
    }, [])

    return (
        <MemoryRouter initialEntries={[fixture.route ?? `/views/${HARNESS_VIEW_ID}`]}>
            <QueryClientProvider client={queryClient}>
                <HarnessPage />
                <div className="fixed inset-0 flex flex-col bg-canvas text-ink">
                    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-glass-border bg-canvas-elevated px-4 text-xs text-ink-muted">
                        <span className="font-display font-semibold text-ink">{viewName}</span>
                        <span className="font-mono">fixture={fixtureName} · {persona} · {dark ? 'dark' : 'light'} · {width}px</span>
                        <span className="truncate">{fixture.note}</span>
                        {canvasSaid && <span className="ml-auto font-mono text-accent-lineage">canvas: {canvasSaid}</span>}
                    </div>
                    <div className="flex min-h-0 flex-1 overflow-hidden">
                        <main className="relative flex-1 overflow-hidden bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]">
                            {fixture.dock && <StandInDock />}
                            {fixture.checklist && <FirstStepsChecklist graphId="harness" mainHeadSeq={1} />}
                        </main>
                        <AssistantRail />
                    </div>
                </div>
                <AssistantLauncher />
                {fixture.notify && <NotificationStack />}
            </QueryClientProvider>
        </MemoryRouter>
    )
}


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Harness />
    </StrictMode>,
)
