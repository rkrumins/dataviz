/**
 * Admin Features page: schema-driven feature flags. Uses useAdminFeatures hook and subcomponents.
 */
import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ToggleLeft, HelpCircle, BookOpen, RotateCcw, AlertCircle, Search, Sparkles, X, Pencil } from 'lucide-react'
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
    updateNotice,
  } = useAdminFeatures()

  const [editNoticeOpen, setEditNoticeOpen] = useState(false)
  const [editEnabled, setEditEnabled] = useState(true)
  const [editTitle, setEditTitle] = useState('')
  const [editMessage, setEditMessage] = useState('')
  const openEditNotice = () => {
    setEditEnabled(!!experimentalNotice)
    setEditTitle(experimentalNotice?.title ?? '')
    setEditMessage(experimentalNotice?.message ?? '')
    setEditNoticeOpen(true)
  }
  const saveEditNotice = () => {
    updateNotice({ enabled: editEnabled, title: editTitle || undefined, message: editMessage || undefined })
    setEditNoticeOpen(false)
  }

  const schema = data?.schema ?? featuresService.getSchema()
  const categories: FeatureCategory[] = data?.categories ?? featuresService.getCategories()
  const values = data?.values ?? {}
  const experimentalNotice = data?.experimentalNotice ?? undefined
  const noticeEnabled = experimentalNotice?.enabled !== false
  const showSearch = schema.length >= SEARCH_MIN_FEATURES
  const q = searchQuery.trim().toLowerCase()

  const categoryMetaById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c])),
    [categories]
  )
  const { byCategory, categoryIds } = useMemo(() => {
    const byCat = schema.reduce<Record<string, FeatureDefinition[]>>((acc, f) => {
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
    Object.keys(byCat).forEach((cat) => {
      byCat[cat].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))
    })
    const ids = Object.keys(byCat).sort(
      (a, b) => (categoryMetaById[a]?.sortOrder ?? 99) - (categoryMetaById[b]?.sortOrder ?? 99)
    )
    return { byCategory: byCat, categoryIds: ids }
  }, [schema, showSearch, q, categoryMetaById])

  if (isLoading) return <SkeletonCards />

  const lastSavedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null
  const isUsingDefaults = !data?.updatedAt && !defaultsHintDismissed

  return (
    <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
      {/* Early access / experimental notice — backend-driven; Disable = turn off (persisted); Enable = turn back on */}
      <AnimatePresence>
        {(experimentalNotice?.title || editNoticeOpen) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.2 }}
            className={`mb-6 rounded-2xl border p-4 ${
              noticeEnabled
                ? 'border-amber-500/20 bg-gradient-to-r from-amber-500/8 via-amber-500/5 to-transparent'
                : 'border-amber-500/10 bg-amber-500/5'
            }`}
          >
            {editNoticeOpen ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">Edit notice</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditNoticeOpen(false)}
                      className="text-sm text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveEditNotice}
                      className="px-4 py-2 rounded-xl bg-amber-500/25 hover:bg-amber-500/35 text-amber-900 dark:text-amber-100 text-sm font-medium shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-900"
                    >
                      Save changes
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="text-sm text-amber-800 dark:text-amber-200">Display banner on page</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={editEnabled}
                    onClick={() => setEditEnabled(!editEnabled)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-gray-900 ${
                      editEnabled
                        ? 'border-amber-500/40 bg-amber-500/25'
                        : 'border-amber-500/20 bg-amber-500/10'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-amber-600 dark:bg-amber-400 shadow-sm ring-0 transition-transform mt-0.5 ${
                        editEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                      aria-hidden
                    />
                  </button>
                </div>
                <div>
                  <label htmlFor="notice-title" className="block text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">Title</label>
                  <input
                    id="notice-title"
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Early access"
                    maxLength={200}
                    className="w-full px-3 py-2 rounded-lg border border-amber-500/20 bg-white/50 dark:bg-black/20 text-ink text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="notice-message" className="block text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">Message</label>
                  <textarea
                    id="notice-message"
                    value={editMessage}
                    onChange={(e) => setEditMessage(e.target.value)}
                    placeholder="Optional body text..."
                    maxLength={2000}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-amber-500/20 bg-white/50 dark:bg-black/20 text-ink text-sm resize-y"
                  />
                </div>
              </div>
            ) : noticeEnabled ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0 w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                    {experimentalNotice?.title}
                  </p>
                  {experimentalNotice?.message && (
                    <p className="text-sm text-amber-700/90 dark:text-amber-300/90 mt-0.5 leading-relaxed">
                      {experimentalNotice.message}
                    </p>
                  )}
                  {experimentalNotice?.updatedAt && (
                    <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-1.5">
                      Last edited {new Date(experimentalNotice.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={openEditNotice}
                    className="p-2 rounded-xl text-amber-600/80 hover:text-amber-700 hover:bg-amber-500/15 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    aria-label="Edit notice"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => updateNotice({ enabled: false })}
                    className="px-3 py-2 rounded-xl text-sm font-medium text-amber-700 dark:text-amber-300 border border-amber-500/25 hover:border-amber-500/40 hover:bg-amber-500/10 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    Turn off
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Banner is hidden. It will show again on refresh when turned on.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={openEditNotice}
                    className="p-2 rounded-xl text-amber-600/80 hover:text-amber-700 hover:bg-amber-500/15 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    aria-label="Edit notice"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => updateNotice({ enabled: true, title: experimentalNotice?.title, message: experimentalNotice?.message })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-amber-800 dark:text-amber-200 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/20 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    Turn on
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

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
              <X className="w-4 h-4" aria-hidden />
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
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {data?.experimentalNotice && (
            <button
              type="button"
              onClick={openEditNotice}
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
