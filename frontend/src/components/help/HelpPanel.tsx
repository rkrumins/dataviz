/**
 * HelpPanel — an in-app slide-over Help drawer.
 *
 * Lets users search the docs + user guide and read guide articles without
 * leaving their workflow. Two internal views (local state):
 *   • home    — search box (live full-text results) + curated quick-start links
 *   • article — a guide article rendered inline, with a Back button and a link
 *               out to the full /guide/:slug page.
 *
 * Docs results (dense engineering reference) link out to /docs/:slug in a new
 * tab rather than rendering in the narrow drawer.
 *
 * Overlay model mirrors ExplorerPreviewDrawer: a portal to <body>, a plain-CSS
 * <Backdrop> (never inside AnimatePresence), and a framer-motion panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import {
  HelpCircle,
  Search,
  X,
  ChevronLeft,
  ArrowUpRight,
  FileText,
  BookOpen,
  Sparkles,
  Check,
  Rocket,
} from 'lucide-react'
import { useFeature } from '@/store/features'
import { useTourStore } from '@/features/tour/tourStore'
import { TOURS } from '@/features/tour/tours'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { useHelpPanelStore } from '@/store/helpPanel'
import { useBrand } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { useDocsLoader } from '@/hooks/useDocsLoader'
import {
  useDocsSearchIndex,
  type DocsSearchResult,
  type SnippetSegment,
} from '@/components/docs/search/useDocsSearchIndex'
import {
  getGuideEntry,
  type GuideEntry,
} from '@/components/guide/guideConfig'
import { guideMarkdownComponents } from '@/components/guide/guideMarkdown'
import { GettingStarted } from '@/components/onboarding/GettingStarted'

// Curated quick-start links — a handful of high-value guide articles.
const QUICK_START_SLUGS = [
  'key-concepts',
  'quick-start',
  'exploring-graph',
  'versioning-change-control',
  'users-access',
] as const

const AREA_LABEL: Record<DocsSearchResult['area'], string> = {
  docs: 'Documentation',
  guide: 'User Guide',
}

const AREA_ICON = {
  docs: FileText,
  guide: BookOpen,
} as const

export function HelpPanel() {
  const open = useHelpPanelStore((s) => s.open)
  const intent = useHelpPanelStore((s) => s.intent)
  const closeHelp = useHelpPanelStore((s) => s.closeHelp)

  // Internal views keep the user in-app.
  const [view, setView] = useState<'home' | 'article' | 'getting-started'>('home')
  const [articleSlug, setArticleSlug] = useState<string | null>(null)

  const close = () => {
    closeHelp()
  }

  // Fresh state each time the drawer opens — landing on whichever view the
  // opener asked for (the sidebar launcher opens straight to Getting Started).
  useEffect(() => {
    if (open) {
      setView(intent === 'getting-started' ? 'getting-started' : 'home')
      setArticleSlug(null)
    }
  }, [open, intent])

  // Close on Escape (in addition to the ✕ and backdrop click).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const openArticle = (slug: string) => {
    setArticleSlug(slug)
    setView('article')
  }

  const content = (
    <>
      <Backdrop open={open} onClick={close} zClassName="z-[60]" />

      <AnimatePresence>
        {open && (
          <motion.aside
            key="help-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Help"
            className={cn(
              'fixed right-0 top-0 h-full w-[440px] max-w-[92vw] z-[61]',
              'bg-canvas border-l border-glass-border',
              'flex flex-col overflow-hidden',
              'shadow-lg',
            )}
            initial={{ x: 440 }}
            animate={{ x: 0 }}
            exit={{ x: 440 }}
            transition={MOTION.drawerSlide}
          >
            {view === 'article' && articleSlug ? (
              <ArticleView
                slug={articleSlug}
                onBack={() => setView('home')}
                onClose={close}
              />
            ) : view === 'getting-started' ? (
              <GettingStartedView onBack={() => setView('home')} onClose={close} />
            ) : (
              <HomeView
                onSelectGuide={openArticle}
                onOpenGettingStarted={() => setView('getting-started')}
                onClose={close}
              />
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )

  return createPortal(content, document.body)
}

// ── Home view ───────────────────────────────────────────────────────

function HomeView({
  onSelectGuide,
  onOpenGettingStarted,
  onClose,
}: {
  onSelectGuide: (slug: string) => void
  onOpenGettingStarted: () => void
  onClose: () => void
}) {
  const brand = useBrand()
  const { ready, search } = useDocsSearchIndex()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const toursEnabled = useFeature('toursEnabled')
  const startTour = useTourStore((s) => s.start)
  const completedTours = useTourStore((s) => s.completed)

  // Focus the search input when the home view mounts (i.e. on open / back).
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const groups = useMemo(() => {
    if (!ready || !query.trim()) return []
    const ranked = search(query)
    return (['docs', 'guide'] as const)
      .map((area) => ({ area, items: ranked.filter((r) => r.area === area) }))
      .filter((g) => g.items.length > 0)
  }, [ready, query, search])

  const quickStart = useMemo(
    () =>
      QUICK_START_SLUGS.map((slug) => getGuideEntry(slug)).filter(
        (e): e is GuideEntry => Boolean(e),
      ),
    [],
  )

  const hasQuery = query.trim().length > 0

  const selectResult = (result: DocsSearchResult) => {
    if (result.area === 'guide') {
      onSelectGuide(result.slug)
    } else {
      // Dense engineering docs — open the full page in a new tab.
      window.open(`/docs/${result.slug}`, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-4 border-b border-glass-border/60">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-accent-lineage/12 flex items-center justify-center shrink-0">
            <HelpCircle className="w-4.5 h-4.5 text-accent-lineage" />
          </div>
          <h2 className="text-ink text-base font-bold leading-none">Help</h2>
        </div>
        <button
          onClick={onClose}
          aria-label="Close help"
          className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Search input */}
      <div className="px-5 pt-4 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the docs & user guide…"
            aria-label="Search help"
            className="input w-full pl-9"
          />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-6">
        {hasQuery ? (
          !ready ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              Building search index…
            </p>
          ) : groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              No results for &ldquo;<span className="text-ink">{query}</span>&rdquo;.
            </p>
          ) : (
            <div className="space-y-4 pt-1">
              {groups.map((group) => {
                const AreaIcon = AREA_ICON[group.area]
                return (
                  <div key={group.area}>
                    <div className="px-1 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                      {AREA_LABEL[group.area]}
                    </div>
                    <ul className="space-y-1">
                      {group.items.map((result) => (
                        <li key={`${result.area}-${result.slug}`}>
                          <button
                            onClick={() => selectResult(result)}
                            className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-100 group"
                          >
                            <div className="mt-0.5 w-8 h-8 rounded-lg bg-black/5 dark:bg-white/5 text-ink-secondary flex items-center justify-center shrink-0 group-hover:bg-accent-lineage/15 group-hover:text-accent-lineage transition-colors">
                              <AreaIcon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium text-ink truncate">
                                  {interpolateBrand(result.title, brand)}
                                </p>
                                {result.area === 'docs' && (
                                  <ArrowUpRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                                )}
                              </div>
                              <p className="mt-0.5 text-xs text-ink-secondary line-clamp-2">
                                <Snippet segments={result.snippet} brand={brand} />
                              </p>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          // Quick-start links
          <div className="pt-1">
            <button
              onClick={onOpenGettingStarted}
              className="group mb-4 flex w-full items-center gap-3 rounded-lg border border-accent-lineage/30 bg-accent-lineage/[0.05] px-3 py-3 text-left transition-colors hover:border-accent-lineage/50 hover:bg-accent-lineage/[0.08]"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/12 text-accent-lineage">
                <Rocket className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">Getting started</p>
                <p className="truncate text-xs text-ink-muted">
                  Track your setup progress, step by step
                </p>
              </div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-muted group-hover:text-accent-lineage" />
            </button>
            {toursEnabled && (
              <div className="mb-4">
                <div className="flex items-center gap-1.5 px-1 pb-2 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
                  <Sparkles className="h-3 w-3" /> Take a tour
                </div>
                <ul className="space-y-1">
                  {TOURS.map((t) => {
                    const done = completedTours.includes(t.id)
                    return (
                      <li key={t.id}>
                        <button
                          onClick={() => {
                            startTour(t.id)
                            onClose()
                          }}
                          className="group flex w-full items-center gap-3 rounded-lg border border-glass-border bg-canvas-elevated px-3 py-2.5 text-left transition-colors hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.04]"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
                            <t.icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                              {t.title}
                              {done && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                            </p>
                            <p className="truncate text-xs text-ink-muted">{t.estimate} · {t.description}</p>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            <div className="px-1 pb-2 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
              Quick start
            </div>
            <ul className="space-y-1">
              {quickStart.map((entry) => (
                <li key={entry.slug}>
                  <button
                    onClick={() => onSelectGuide(entry.slug)}
                    className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-100 group"
                  >
                    <div className="mt-0.5 w-8 h-8 rounded-lg bg-accent-lineage/10 text-accent-lineage flex items-center justify-center shrink-0">
                      <BookOpen className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {interpolateBrand(entry.title, brand)}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-secondary line-clamp-2">
                        {interpolateBrand(entry.description, brand)}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <Link
              to="/guide"
              onClick={onClose}
              className="mt-3 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-glass-border text-sm font-medium text-ink-secondary hover:text-ink hover:border-accent-lineage/40 transition-colors"
            >
              Browse the full user guide
              <ArrowUpRight className="w-4 h-4" />
            </Link>
          </div>
        )}
      </div>
    </>
  )
}

// ── Article view ────────────────────────────────────────────────────

function ArticleView({
  slug,
  onBack,
  onClose,
}: {
  slug: string
  onBack: () => void
  onClose: () => void
}) {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const entry = getGuideEntry(slug)
  const { content, isLoading, error } = useDocsLoader(entry)

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4 border-b border-glass-border/60">
        <button
          onClick={onBack}
          aria-label="Back to help home"
          className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 rounded-lg text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <div className="flex items-center gap-1">
          {entry && (
            <Link
              to={`/guide/${entry.slug}`}
              onClick={onClose}
              title="Open full page"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
            >
              Open full page
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
          <button
            onClick={onClose}
            aria-label="Close help"
            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-5">
        {error || !entry ? (
          <div className="py-12 text-center space-y-2">
            <FileText className="w-10 h-10 text-ink-muted mx-auto" />
            <p className="text-sm text-ink-muted">
              This article couldn&rsquo;t be loaded.
            </p>
          </div>
        ) : isLoading || content === null ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-6 w-2/3 rounded bg-black/5 dark:bg-white/5" />
            <div className="h-4 w-full rounded bg-black/5 dark:bg-white/5" />
            <div className="h-4 w-11/12 rounded bg-black/5 dark:bg-white/5" />
            <div className="h-4 w-4/5 rounded bg-black/5 dark:bg-white/5" />
          </div>
        ) : (
          <article className="prose-synodic">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, rehypeHighlight]}
              components={guideMarkdownComponents}
            >
              {interp(content)}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </>
  )
}

// ── Getting-started view ────────────────────────────────────────────

function GettingStartedView({
  onBack,
  onClose,
}: {
  onBack: () => void
  onClose: () => void
}) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4 border-b border-glass-border/60">
        <button
          onClick={onBack}
          aria-label="Back to help home"
          className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 rounded-lg text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
        <button
          onClick={onClose}
          aria-label="Close help"
          className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Body — the hub closes the drawer when a step CTA navigates. */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-5">
        <GettingStarted onNavigate={onClose} />
      </div>
    </>
  )
}

// ── Highlighted snippet ─────────────────────────────────────────────

function Snippet({
  segments,
  brand,
}: {
  segments: SnippetSegment[]
  brand: ReturnType<typeof useBrand>
}) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            className="bg-accent-lineage/15 text-accent-lineage font-semibold rounded px-0.5"
          >
            {interpolateBrand(seg.text, brand)}
          </mark>
        ) : (
          <span key={i}>{interpolateBrand(seg.text, brand)}</span>
        ),
      )}
    </>
  )
}
