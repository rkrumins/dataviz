/**
 * Admin Features page: schema-driven feature flags. Uses useAdminFeatures hook and subcomponents.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { ToggleLeft, HelpCircle, BookOpen, RotateCcw, AlertCircle, Search } from 'lucide-react'
import { featuresService, type FeatureDefinition, type FeatureCategory } from '@/services/featuresService'
import { useAdminFeatures, SEARCH_MIN_FEATURES } from '@/hooks/useAdminFeatures'
import { FeatureCard } from './FeatureCard'
import { Toast } from './Toast'
import { SkeletonCards } from './SkeletonCards'
import { ResetConfirmModal, EffectFocusCancel } from './ResetConfirmModal'

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
  } = useAdminFeatures()

  const schema = data?.schema ?? featuresService.getSchema()
  const categories: FeatureCategory[] = data?.categories ?? featuresService.getCategories()
  const categoryMetaById = Object.fromEntries(categories.map((c) => [c.id, c]))
  const values = data?.values ?? {}
  const showSearch = schema.length >= SEARCH_MIN_FEATURES
  const q = searchQuery.trim().toLowerCase()
  const byCategory = schema.reduce<Record<string, FeatureDefinition[]>>((acc, f) => {
    if (f.deprecated) return acc
    if (showSearch && q) {
      const match =
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        (f.category || '').toLowerCase().includes(q)
      if (!match) return acc
    }
    const cat = f.category || 'other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(f)
    return acc
  }, {})
  Object.keys(byCategory).forEach((cat) => {
    byCategory[cat].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
  })
  const categoryIds = Object.keys(byCategory).sort(
    (a, b) => (categoryMetaById[a]?.sortOrder ?? 99) - (categoryMetaById[b]?.sortOrder ?? 99)
  )

  if (isLoading) return <SkeletonCards />

  const lastSavedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null
  const isUsingDefaults = !data?.updatedAt && !defaultsHintDismissed

  return (
    <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
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
              Using default settings. Changes are saved automatically when you toggle a feature.
            </p>
            <button
              type="button"
              onClick={() => setDefaultsHintDismissed(true)}
              className="p-1 rounded-lg hover:bg-indigo-500/10 transition-colors text-indigo-500/80 hover:text-indigo-600"
              aria-label="Dismiss hint"
            >
              <span className="sr-only">Dismiss</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 mb-10">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <ToggleLeft className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">Features</h1>
            <p className="text-sm text-ink-muted mt-1">
              Control product behaviour: editing, view types, signup, and lineage trace.
            </p>
            {lastSavedAt && (
              <p className="text-xs text-ink-muted mt-1.5" aria-live="polite">
                Last saved at {lastSavedAt}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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

      {showSearch && (
        <div className="mb-6">
          <label htmlFor="features-search" className="sr-only">
            Search features
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
            <input
              id="features-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search features by name or description…"
              className="w-full max-w-md pl-10 pr-4 py-2.5 rounded-xl border border-glass-border bg-canvas-elevated text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/30"
              aria-describedby={searchQuery ? 'features-search-hint' : undefined}
            />
          </div>
          {searchQuery && (
            <p id="features-search-hint" className="text-xs text-ink-muted mt-1.5">
              Showing features matching "{searchQuery}"
            </p>
          )}
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

      {showSearch && q && Object.keys(byCategory).length === 0 ? (
        <p className="text-sm text-ink-muted py-8 text-center">
          No features match "{searchQuery}". Try a different search.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {categoryIds.map((categoryId, index) => {
            const features = byCategory[categoryId]
            if (!features?.length) return null
            return (
              <FeatureCard
                key={categoryId}
                categoryId={categoryId}
                meta={categoryMetaById[categoryId]}
                features={features}
                values={values}
                onChange={handleChange}
                savingKey={savingKey}
                index={index}
              />
            )
          })}
        </div>
      )}

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
    </div>
  )
}
