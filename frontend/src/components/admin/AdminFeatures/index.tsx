/**
 * Admin → Features.
 *
 * This page decides what every user of the deployment can and cannot do, and for most of its life
 * it was a list of switches with a name and a sentence each. That shape asks an admin to make a
 * decision it gives them no information to make: it says what a feature is CALLED, never what
 * turning it off would do to the people using the product, and — until the gates went in — eight
 * of its twelve switches did nothing at all.
 *
 * So it is now a console, in three layers:
 *
 *   POSTURE   (FeatureHero)       what is my deployment doing right now? answered before you read
 *                                 a single switch, because that is the question you came with.
 *   TILES     (FeatureTile)       one card per feature. State on its face; an OFF feature carries
 *                                 its consequence without being asked.
 *   THE SPEC  (FeatureDetailSheet) what it is, when-on vs when-off side by side, which endpoints
 *                                 refuse, what still works, what depends on it.
 *
 * And one asymmetry that matters more than any of the layout: TURNING A FEATURE OFF ASKS FIRST
 * (ConfirmTurnOff); turning it back on does not. Off is the direction that silently takes
 * something away from everybody, and the person doing it is not the person who will notice.
 */
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, BookOpen, HelpCircle, Pencil, RotateCcw, Search, ToggleLeft, X } from 'lucide-react'
import { featuresService, type FeatureCategory, type FeatureDefinition } from '@/services/featuresService'
import { useAdminFeatures, SEARCH_MIN_FEATURES } from '@/hooks/useAdminFeatures'
import { PageContainer } from '@/components/layout/PageContainer'
import { resolveCategoryStyle } from './constants'
import { ConfirmTurnOff } from './ConfirmTurnOff'
import { ExperimentalNoticeBanner } from './ExperimentalNoticeBanner'
import { FeatureDetailSheet } from './FeatureDetailSheet'
import { FeatureHero } from './FeatureHero'
import { FeatureTile } from './FeatureTile'
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
  /** The feature whose spec sheet is open. */
  const [openKey, setOpenKey] = useState<string | null>(null)
  /** The feature we are about to turn OFF, pending confirmation. */
  const [pendingOff, setPendingOff] = useState<FeatureDefinition | null>(null)

  const schema = data?.schema ?? featuresService.getSchema()
  const categories: FeatureCategory[] = data?.categories ?? featuresService.getCategories()
  const values = data?.values ?? {}
  const showSearch = schema.length >= SEARCH_MIN_FEATURES
  const q = searchQuery.trim().toLowerCase()

  const live = useMemo(() => schema.filter(f => !f.deprecated), [schema])
  const categoryMetaById = useMemo(
    () => Object.fromEntries(categories.map(c => [c.id, c])),
    [categories]
  )

  const { byCategory, categoryIds } = useMemo(() => {
    const byCat = live.reduce<Record<string, FeatureDefinition[]>>((acc, f) => {
      if (showSearch && q) {
        const match =
          f.name.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q) ||
          (f.impactWhenOff ?? '').toLowerCase().includes(q) ||
          (f.category || '').toLowerCase().includes(q)
        if (!match) return acc
      }
      const cat = f.category || 'other'
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(f)
      return acc
    }, {})
    Object.keys(byCat).forEach(cat => {
      byCat[cat].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
    })
    const ids = Object.keys(byCat).sort(
      (a, b) => (categoryMetaById[a]?.sortOrder ?? 99) - (categoryMetaById[b]?.sortOrder ?? 99)
    )
    return { byCategory: byCat, categoryIds: ids }
  }, [live, showSearch, q, categoryMetaById])

  if (isLoading) return <SkeletonCards />

  const openFeature = live.find(f => f.key === openKey) ?? null
  const lastSavedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null
  const isUsingDefaults = !data?.updatedAt && !defaultsHintDismissed

  /**
   * ON is instant. OFF asks first.
   *
   * Not friction for its own sake: this is the only moment an admin is guaranteed to be looking at
   * the consequence of what they're about to do to every user at once.
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

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 mb-8">
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

      <FeatureHero features={live} values={values} onSelect={setOpenKey} />

      {showSearch && (
        <div className="mb-8">
          <label htmlFor="features-search" className="sr-only">Search features</label>
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
            <input
              id="features-search"
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search features — by name, what they do, or what happens when they're off…"
              className="w-full max-w-xl pl-10 pr-4 py-3 rounded-2xl border border-glass-border bg-canvas-elevated text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
            />
          </div>
        </div>
      )}

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

      {showSearch && q && categoryIds.length === 0 ? (
        <p className="text-sm text-ink-muted py-16 text-center">
          Nothing matches "{searchQuery}".
        </p>
      ) : (
        <div className="space-y-10">
          {categoryIds.map(categoryId => {
            const features = byCategory[categoryId]
            if (!features?.length) return null
            const meta = categoryMetaById[categoryId]
            const { Icon, style, label } = resolveCategoryStyle(meta, categoryId)

            return (
              <section key={categoryId}>
                <div className="flex items-center gap-2.5 mb-4">
                  <div className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${style.iconBg}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <h2 className="text-sm font-semibold tracking-wide uppercase text-ink-secondary">
                    {label}
                  </h2>
                  <span className="text-xs text-ink-muted">{features.length}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {features.map(feature => (
                    <FeatureTile
                      key={feature.key}
                      feature={feature}
                      allFeatures={live}
                      values={values}
                      meta={meta}
                      saving={savingKey === feature.key}
                      onToggle={next => requestToggle(feature, next)}
                      onOpen={() => setOpenKey(feature.key)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <FeatureDetailSheet
        feature={openFeature}
        allFeatures={live}
        values={values}
        meta={openFeature ? categoryMetaById[openFeature.category] : undefined}
        saving={Boolean(openFeature && savingKey === openFeature.key)}
        onToggle={next => openFeature && requestToggle(openFeature, next)}
        onChangeOptions={next => openFeature && handleChange(openFeature.key, next)}
        onClose={() => setOpenKey(null)}
      />

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
