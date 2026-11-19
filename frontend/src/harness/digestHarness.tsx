/**
 * Visual harness for "what changed since you last looked" and watching: the REAL chip, sheet and
 * watch toggles — their own queries — against `digestFetch`, an in-memory API. The page around them
 * is a stand-in: the view's header (with the real graph watch toggle), the canvas versioning bar
 * (its published-state strip, with the real chip), a dotted canvas and the real entity panel header
 * (with the real entity watch toggle). No backend, no auth. `scripts/digest-shot.mjs` drives it.
 *
 *   npm run harness
 *   open http://localhost:5199/digest-harness.html?scenario=ok&sheet=1&theme=dark
 *
 *   scenario   ok | week | truncated | cut | empty | loading | error (see digestFixtures)
 *   sheet      1: the sheet open
 *   theme      `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { Info, PanelRight } from 'lucide-react'
import { StrictMode, useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { EntityHeader } from '../components/panels/entity/EntityHeader'
import { Tabs } from '../components/ui/Tabs'
import { NotificationStack } from '../components/ui/notifications'
import { DigestChip } from '../features/versioning/components/DigestChip'
import { DigestSheet } from '../features/versioning/components/DigestSheet'
import { EntityWatchButton, GraphWatchButton } from '../features/versioning/components/WatchButtons'
import { ME } from '../features/versioning/components/__fixtures__/digest'
import { useAuthStore } from '../store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'
import { DS, ENTITY_URN, GRAPH, VIEW, WS, digestFetch, type Scenario } from './digestFixtures'

const params = new URLSearchParams(window.location.search)
const scenario = (params.get('scenario') ?? 'ok') as Scenario
const dark = params.get('theme') === 'dark'

// Every animation lands on its end state at once: a screenshot otherwise catches a sheet mid-slide.
MotionGlobalConfig.skipAnimations = true
const still = document.createElement('style')
still.textContent = '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }'
document.head.appendChild(still)

window.fetch = digestFetch(scenario)
useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never)
useAuthStore.setState({
  user: { id: ME, email: 'morgan@example.com', firstName: 'Morgan', lastName: 'Lee' },
  permissions: { sid: 'harness', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready',
} as never)
usePersonaStore.setState({ mode: 'technical' })

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
// Matches the view page header's action buttons (ViewPageHeader's ACTION_BUTTON).
const ACTION = 'inline-flex items-center gap-1.5 rounded-lg font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 px-2.5 py-1.5 text-xs'

export function Harness() {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const [open, setOpen] = useState(params.get('sheet') === '1')
  const titleId = useId()
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }, [setTheme])
  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-glass-border">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-ink-muted">Finance · Lineage view</p>
          <h1 className="text-base font-semibold truncate">Sales lineage</h1>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={ACTION} aria-label="Details"><Info className="w-3.5 h-3.5" aria-hidden /><span className="hidden lg:inline">Details</span></button>
          <button type="button" className={ACTION} aria-label="Reviews"><PanelRight className="w-3.5 h-3.5" aria-hidden /><span className="hidden lg:inline">Reviews</span></button>
          <GraphWatchButton workspaceId={WS} dataSourceId={DS} viewId={VIEW} className={ACTION} />
        </div>
      </header>
      {/* The canvas versioning bar on Published (CanvasVersioningBar's row). */}
      <div className="empty:hidden flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 border-b text-sm shrink-0 min-w-0 bg-black/[0.025] dark:bg-white/[0.025] border-glass-border">
        <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold text-ink bg-black/[0.04] dark:bg-white/[0.06]">Published</span>
        <DigestChip workspaceId={WS} graphId={GRAPH} onOpen={() => setOpen(true)} />
      </div>
      <div className="relative flex-1 min-h-[560px] flex flex-col md:flex-row">
        <div className="min-h-[120px] flex-1 bg-[radial-gradient(circle,rgba(100,116,139,0.18)_1px,transparent_1px)] [background-size:18px_18px]" />
        <aside className="flex w-full md:w-[380px] shrink-0 flex-col border-t md:border-t-0 md:border-l border-glass-border bg-canvas-elevated">
          <Tabs value="view">
            <EntityHeader
              nodeId={ENTITY_URN}
              titleId={titleId}
              typeName="Dataset"
              colors={{ accent: '#6366f1', bg: 'rgba(99,102,241,0.12)', text: '#4f46e5' }}
              title="Orders"
              isGhost={false}
              onRestore={() => {}}
              copiedUrn={false}
              onCopyUrn={() => {}}
              externalUrl={null}
              editable={false}
              dirty={false}
              onClose={() => {}}
              watch={<EntityWatchButton wsId={WS} graphId={GRAPH} urn={ENTITY_URN} name="Orders" />}
            />
          </Tabs>
        </aside>
      </div>
      <DigestSheet wsId={WS} graphId={GRAPH} mainBranchId="br_main" open={open} onOpenChange={setOpen} onCompare={() => setOpen(false)} />
      <NotificationStack />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/views/${VIEW}`]}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
)
