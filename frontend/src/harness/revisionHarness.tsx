/**
 * Visual harness for the revision history viewer.
 *
 * Renders the REAL banner, History tab, month picker and comparison — their own hooks and queries —
 * against `revisionFetch`, an in-memory history answering the versioning routes they read. No API,
 * no auth, no canvas: a dotted region stands in for the canvas under the banner. Every state is a URL
 * away, so each can be looked at, in both themes.
 *
 *   npm run harness
 *   open http://localhost:5199/revision-harness.html?fixture=history&theme=dark
 *
 * `npm run harness:revision` drives Chromium over every fixture and writes PNGs to .harness/.
 *
 *   fixture   banner | opening | rewinding | history | months | compare | toofar (default banner)
 *   theme     `dark` for the dark palette
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionGlobalConfig } from 'framer-motion'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import '../styles/globals.css'
import { RevisionBanner } from '../features/versioning/components/RevisionBanner'
import { ViewVersioningPanel } from '../features/versioning/components/ViewVersioningPanel'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '../providers/ViewExecutionContext'
import { useAuthStore } from '../store/auth'
import { useBranchStore } from '../store/branchStore'
import { useCanvasStore } from '../store/canvas'
import { DEFAULT_FEATURES, useFeaturesStore } from '../store/features'
import { usePreferencesStore } from '../store/preferences'
import type { CompareRequest } from '../store/versioningPanelStore'
import { HARNESS_DS, HARNESS_GRAPH, HARNESS_VIEW, HARNESS_WS, HEAD, revisionFetch, revisionInfo } from './revisionFixtures'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'banner'
const dark = params.get('theme') === 'dark'

// Every animation lands on its end state at once: a screenshot taken on Chromium's virtual clock
// otherwise catches a panel mid-slide.
MotionGlobalConfig.skipAnimations = true
window.fetch = revisionFetch()

useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, revisionViewerEnabled: true } } as never)
useAuthStore.setState({ permissions: { sid: 'harness', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
useBranchStore.getState().setResolved(
  { workspaceId: HARNESS_WS, dataSourceId: HARNESS_DS, viewId: HARNESS_VIEW },
  { graphId: HARNESS_GRAPH, mainBranchId: 'br_main', mainHeadCommitSeq: HEAD },
)

const SEQ = 172
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const SCHEMA: ResolvedViewSchema = {
  entityTypes: [], relationshipTypes: [], containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['FLOWS_TO'],
  rootEntityTypes: [],
}

const BANNER = ['banner', 'opening', 'rewinding'].includes(fixture)
const COMPARE: Record<string, CompareRequest> = {
  compare: { fromSeq: SEQ, toSeq: null },
  toofar: { fromSeq: 40, toSeq: null, notice: 'too_far' },
}

function Harness() {
  const setTheme = usePreferencesStore((s) => s.setTheme)
  useEffect(() => {
    setTheme(dark ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', dark)
  }, [setTheme])
  useEffect(() => {
    if (BANNER) {
      const { commit: c, headSeq } = revisionInfo(SEQ)
      useBranchStore.getState().openRevision({ seq: SEQ, headAtOpen: headSeq, commitId: c.commit_id, createdAt: c.created_at, message: c.message, actor: c.actor })
      useCanvasStore.setState({ hydrationPhase: fixture === 'rewinding' ? 'roots' : 'complete' } as never)
    }
    if (fixture === 'months') {
      // Open the picker, then October: the year's heat and the month's days.
      const t = setTimeout(() => {
        document.querySelector<HTMLButtonElement>('[aria-label="Go to a month"]')?.click()
        setTimeout(() => {
          const oct = [...document.querySelectorAll<HTMLButtonElement>('[role="group"] button')]
            .find((b) => b.getAttribute('aria-label')?.includes('2026: 28'))
          oct?.click()
        }, 150)
      }, 300)
      return () => clearTimeout(t)
    }
  }, [])

  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <div className="fixed inset-0 flex flex-col bg-canvas-base text-ink">
          <div className="h-11 shrink-0 flex items-center gap-3 px-4 border-b border-glass-border text-xs text-ink-muted">
            <span className="font-display font-semibold text-ink">Enterprise lineage</span>
            <span className="font-mono">fixture={fixture} · {dark ? 'dark' : 'light'}</span>
          </div>
          {BANNER && (
            <StaticViewSchemaProvider schema={SCHEMA} asOfSeq={fixture === 'opening' ? null : SEQ}>
              <RevisionBanner workspaceId={HARNESS_WS} graphId={HARNESS_GRAPH} canRestore onCompare={() => {}} />
            </StaticViewSchemaProvider>
          )}
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
            compare={COMPARE[fixture] ?? null}
            onExport={() => {}}
            onClose={() => {}}
          />
        )}
      </QueryClientProvider>
    </MemoryRouter>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
