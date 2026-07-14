/**
 * Admin → Features.
 *
 * This page decides what every user of the deployment can and cannot do. For most of its life it
 * was a list of switches with a name and a sentence each — a shape that asks an admin to make a
 * decision it gives them nothing to make it with. It said what a feature was CALLED and never what
 * turning it off would do to the people using the product.
 *
 * It is now a two-pane console, and the two panes answer the two questions people actually arrive
 * with:
 *
 *   LEFT   "what have I got, and what state is it in?"   — all twelve at once, scannable, with the
 *                                                          switch right there, because the common
 *                                                          case is flipping something you already
 *                                                          understand.
 *   RIGHT  "what IS this, and what happens if I touch it?" — the full spec, ALWAYS open. It used to
 *                                                          be a modal, which meant the default state
 *                                                          of the page explained nothing, and an
 *                                                          explanation you have to go and ask for is
 *                                                          one most people never see.
 *
 * Above both, the posture strip: what your users cannot do right now, answered before you read a
 * single switch, because that is the question that brought you here.
 *
 * The layout it replaces spent a full screen of scrolling on twelve items — six category headings,
 * each followed by ONE card in a three-column grid, so most of the page was the empty space beside a
 * lone tile. Categories are dividers now, not sections.
 *
 * One asymmetry, and it matters more than the layout: TURNING A FEATURE OFF ASKS FIRST
 * (ConfirmTurnOff); turning it back on does not. Off silently takes something away from every user
 * at once, and the person doing it is by definition not the person who will notice.
 */
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, BookOpen, HelpCircle, Pencil, RotateCcw, Search, ToggleLeft, X } from 'lucide-react'
import { featuresService, type FeatureCategory, type FeatureDefinition } from '@/services/featuresService'
import { useAdminFeatures, SEARCH_MIN_FEATURES } from '@/hooks/useAdminFeatures'
import { PageContainer } from '@/components/layout/PageContainer'
import { ConfirmTurnOff } from './ConfirmTurnOff'
import { ExperimentalNoticeBanner } from './ExperimentalNoticeBanner'
import { FeatureHero } from './FeatureHero'
import { FeatureList } from './FeatureList'
import { FeatureSpec } from './FeatureSpec'
import { ResetConfirmModal, EffectFocusCancel } from './ResetConfirmModal'
import { SkeletonCards } from './SkeletonCards'
import { Toast } from './Toast'
import { isOn } from './featureState'

export function AdminFeatures() {
  const {
    data,
    isLoading,
    error,
    load,
    handleChange,
    savingKey,
    toastVisible,
    setToastVisible,
    errorToastVisible,
    setErrorToastVisible,
    errorToastMessage,
    resetConfirmOpen,
    setResetConfirmOpen,
    handleReset,
    resetLoading,
    defaultsHintDismissed,
    setDefaultsHintDismissed,
    searchQuery,
    setSearchQuery,
    resetModalRef,
    cancelButtonRef,
    updateNotice,
  } = useAdminFeatures()

  const [editNoticeOpen, setEditNoticeOpen] = useState(false)
  /** Which feature the spec pane is explaining. Null means "the first one". */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** The feature we are about to turn OFF, pending confirmation. */
  const [pendingOff, setPendingOff] = useState<FeatureDefinition | null>(null)

  const schema = data?.schema ?? featuresService.getSchema()
  const categories: FeatureCategory[] = data?.categories ?? featuresService.getCategories()
  const values = data?.values ?? {}
  const showSearch = schema.length >= SEARCH_MIN_FEATURES
  const q = searchQuery.trim().toLowerCase()

  const live = useMemo(() => schema.filter(f => !f.deprecated), [schema])
  const categoryMetaById = useMemo(
    () => Object.fromEntries(categories.map(c => [c.id, c])) as Record<string, FeatureCategory>,
    [categories]
  )

  /** Categories in display order, each with its features — the left index, and nothing else. */
  const grouped = useMemo<[string, FeatureDefinition[]][]>(() => {
    const byCat = live.reduce<Record<string, FeatureDefinition[]>>((acc, f) => {
      if (showSearch && q) {
        const haystack = [f.name, f.description, f.impactWhenOff ?? '', f.category ?? '']
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return acc
      }
      const cat = f.category || 'other'
      ;(acc[cat] ??= []).push(f)
      return acc
    }, {})

    return Object.entries(byCat)
      .map(([cat, fs]) => {
        fs.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
        return [cat, fs] as [string, FeatureDefinition[]]
      })
      .sort(
        ([a], [b]) =>
          (categoryMetaById[a]?.sortOrder ?? 99) - (categoryMetaById[b]?.sortOrder ?? 99)
      )
  }, [live, showSearch, q, categoryMetaById])

  if (isLoading) return <SkeletonCards />

  const visible = grouped.flatMap(([, fs]) => fs)
  // The spec pane is never empty: land on something, so the page explains a feature the moment it
  // opens instead of asking you to pick one before it will tell you anything.
  const selected = visible.find(f => f.key === selectedKey) ?? visible[0] ?? null

  const lastSavedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null
  const isUsingDefaults = !data?.updatedAt && !defaultsHintDismissed

  /**
   * ON is instant. OFF asks first.
   *
   * Not friction for its own sake: this is the only moment an admin is guaranteed to be looking at
   * the consequence of what they are about to do to every user at once.
   */
  const requestToggle = (feature: FeatureDefinition, next: boolean) => {
    if (!next && isOn(feature, values)) {
      setPendingOff(feature)
      return
    }
    handleChange(feature.key, next)
  }

  const confirmTurnOff = async () => {
    if (!pendingOff) return
    await handleChange(pendingOff.key, false)
    setPendingOff(null)
  }

  return (
    <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
      <ExperimentalNoticeBanner
        experimentalNotice={data?.experimentalNotice ?? undefined}
        updateNotice={updateNotice}
        editNoticeOpen={editNoticeOpen}
        setEditNoticeOpen={setEditNoticeOpen}
      />

      <AnimatePresence>
        {isUsingDefaults && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 flex items-center gap-3 px-4 py-3 rounded-xl bg-indigo-500/5 border border-indigo-500/10 text-indigo-600 dark:text-indigo-400"
          >
            <HelpCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm flex-1">
              Nothing has been changed yet — every feature is at its shipped default.
            </p>
            <button
              type="button"
              onClick={() => setDefaultsHintDismissed(true)}
              className="p-1 rounded-lg hover:bg-indigo-500/10 transition-colors text-indigo-500/80 hover:text-indigo-600"
              aria-label="Dismiss hint"
            >
              <X className="w-4 h-4" aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <ToggleLeft className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">Features</h1>
            <p className="text-sm text-ink-muted mt-1">
              Everything your users can and cannot do, in one place. Every switch takes effect
              immediately, for everybody.
            </p>
            {lastSavedAt && (
              <p className="text-xs text-ink-muted mt-1.5" aria-live="polite">
                Last saved at {lastSavedAt}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {data?.experimentalNotice && (
            <button
              type="button"
              onClick={() => setEditNoticeOpen(true)}
              className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Pencil className="w-4 h-4" />
              Edit notice
            </button>
          )}
          <a
            href="/docs/features"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-2"
          >
            <BookOpen className="w-4 h-4" />
            Learn more
          </a>
          <button
            type="button"
            onClick={() => setResetConfirmOpen(true)}
            className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to defaults
          </button>
        </div>
      </div>

      <FeatureHero features={live} values={values} onSelect={setSelectedKey} />

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400"
          >
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="flex-1 text-sm">{error}</p>
            <button
              type="button"
              onClick={load}
              className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-sm font-medium transition-colors"
            >
              Retry
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-6 lg:grid-cols-[minmax(300px,360px)_1fr] items-start">
        {/* INDEX — all of them, at once. */}
        <div className="lg:sticky lg:top-6 space-y-3">
          {showSearch && (
            <div className="relative">
              <label htmlFor="features-search" className="sr-only">Search features</label>
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
              <input
                id="features-search"
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search features…"
                className="w-full pl-10 pr-4 py-2.5 rounded-2xl border border-glass-border bg-canvas-elevated text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
              />
            </div>
          )}

          {visible.length === 0 ? (
            <p className="rounded-3xl border border-glass-border bg-canvas-elevated p-6 text-sm text-ink-muted text-center">
              Nothing matches "{searchQuery}".
            </p>
          ) : (
            <div className="lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto rounded-3xl">
              <FeatureList
                grouped={grouped}
                categoryMetaById={categoryMetaById}
                allFeatures={live}
                values={values}
                selectedKey={selected?.key ?? null}
                savingKey={savingKey}
                onSelect={setSelectedKey}
                onToggle={requestToggle}
              />
            </div>
          )}
        </div>

        {/* SPEC — always open, never a modal. */}
        {selected && (
          <FeatureSpec
            key={selected.key}
            feature={selected}
            allFeatures={live}
            values={values}
            meta={categoryMetaById[selected.category]}
            saving={savingKey === selected.key}
            onToggle={next => requestToggle(selected, next)}
            onChangeOptions={next => handleChange(selected.key, next)}
          />
        )}
      </div>

      <ConfirmTurnOff
        feature={pendingOff}
        onCancel={() => setPendingOff(null)}
        onConfirm={confirmTurnOff}
      />

      <ResetConfirmModal
        open={resetConfirmOpen}
        onClose={() => setResetConfirmOpen(false)}
        onConfirm={handleReset}
        loading={resetLoading}
        modalRef={resetModalRef}
        cancelRef={cancelButtonRef}
      />
      {resetConfirmOpen && <EffectFocusCancel cancelRef={cancelButtonRef} />}

      <Toast message="Saved" visible={toastVisible} onDismiss={() => setToastVisible(false)} />
      <Toast
        message={errorToastMessage}
        visible={errorToastVisible}
        onDismiss={() => setErrorToastVisible(false)}
        variant="error"
      />
    </PageContainer>
  )
}
