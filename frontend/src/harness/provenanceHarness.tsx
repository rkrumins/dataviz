/**
 * Visual harness for people and automation in history, and for a draft behind Published (doc 19).
 *
 * Renders the REAL History tab (filter, provenance chips, automation runs) and the real "behind
 * Published" strip, with their own hooks and queries, against `provenanceFetch`, an in-memory
 * history. No API, no auth, no canvas. Every state is a URL away, in both themes.
 *
 *   npm run harness
 *   open http://localhost:5199/provenance-harness.html?fixture=history&theme=dark
 *
 * `npm run harness:provenance` drives Chromium over every fixture and writes PNGs to .harness/.
 *
 *   fixture   history | run | automation | people | behind-auto | behind-people | behind-overlap
 *   theme     `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { PullBeforeMergeBanner } from '../features/versioning/components/PullBeforeMergeBanner'
import { ViewVersioningPanel } from '../features/versioning/components/ViewVersioningPanel'
import { useAuthStore } from '../store/auth'
import { useBranchStore } from '../store/branchStore'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePreferencesStore } from '../store/preferences'
import { HARNESS_DS, HARNESS_GRAPH, HARNESS_VIEW, HARNESS_WS, HEAD, provenanceFetch } from './provenanceFixtures'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'history'
const dark = params.get('theme') === 'dark'
const BANNER = fixture.startsWith('behind-')

MotionGlobalConfig.skipAnimations = true
// Behind automation alone, Published holds the sync's commits but not Ben's publish after them.
window.fetch = provenanceFetch(fixture === 'behind-auto' || fixture === 'behind-overlap' ? 229 : HEAD)

useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, revisionViewerEnabled: true } } as never)
useAuthStore.setState({ permissions: { sid: 'harness', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
useBranchStore.getState().setResolved(
  { workspaceId: HARNESS_WS, dataSourceId: HARNESS_DS, viewId: HARNESS_VIEW },
  { graphId: HARNESS_GRAPH, mainBranchId: 'br_main', mainHeadCommitSeq: HEAD },
)
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const BANNERS: Record<string, Parameters<typeof PullBeforeMergeBanner>[0]> = {
  'behind-auto': { wsId: HARNESS_WS, graphId: HARNESS_GRAPH, branchId: 'br_draft', baseCommitSeq: 217,
    mainHead: 229, required: false },
  'behind-people': { wsId: HARNESS_WS, graphId: HARNESS_GRAPH, branchId: 'br_draft', baseCommitSeq: 217,
    mainHead: HEAD, required: true, reason: 'people', behindByPeople: 1 },
  'behind-overlap': { wsId: HARNESS_WS, graphId: HARNESS_GRAPH, branchId: 'br_draft', baseCommitSeq: 217,
    mainHead: 229, required: true, reason: 'overlap' },
}

/** Click what a fixture opens, once the page has drawn. */
function useOpen() {
  useEffect(() => {
    const click = (find: () => HTMLElement | null | undefined, delay: number) =>
      setTimeout(() => find()?.click(), delay)
    const radio = (name: string) => () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((b) => b.textContent?.includes(name))
    const timers: ReturnType<typeof setTimeout>[] = []
    if (fixture === 'run') {
      timers.push(click(() => [...document.querySelectorAll<HTMLElement>('button[aria-expanded="false"]')]
        .find((b) => b.textContent?.includes('Snowflake sync')), 400))
    }
    if (fixture === 'automation') timers.push(click(radio('Automation'), 400))
    if (fixture === 'people') timers.push(click(radio('People'), 400))
    if (BANNER) {
      timers.push(click(() => [...document.querySelectorAll<HTMLElement>('button')]
        .find((b) => b.textContent?.includes('What changed')), 300))
    }
    return () => timers.forEach(clearTimeout)
  }, [])
}

function Harness() {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }, [setTheme])
  useOpen()

  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <div className="fixed inset-0 flex flex-col bg-canvas-base text-ink">
          <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-glass-border text-xs text-ink-muted">
            <span className="font-display font-semibold text-ink">Enterprise lineage</span>
            {BANNER && <span className="px-2 py-0.5 rounded-md bg-accent-lineage/10 text-accent-lineage font-medium">Draft: Q4 metric names</span>}
            <span className="font-mono">fixture={fixture} · {dark ? 'dark' : 'light'}</span>
          </div>
          {BANNER && <PullBeforeMergeBanner {...BANNERS[fixture]} />}
          <div className="flex-1 bg-[radial-gradient(circle,rgba(127,127,127,0.18)_1px,transparent_1px)] [background-size:18px_18px]" />
        </div>
        {!BANNER && (
          <ViewVersioningPanel
            wsId={HARNESS_WS}
            graphId={HARNESS_GRAPH}
            viewId={HARNESS_VIEW}
            dataSourceId={HARNESS_DS}
            viewName="Enterprise lineage"
            initialTab="history"
            canManage
            onExport={() => {}}
            onClose={() => {}}
          />
        )}
      </QueryClientProvider>
    </MemoryRouter>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
