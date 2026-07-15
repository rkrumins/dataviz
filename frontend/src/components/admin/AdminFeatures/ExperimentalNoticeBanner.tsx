/**
 * The page-level "early access" banner — admin-editable copy, stored in `feature_registry_meta`.
 *
 * Lifted verbatim out of index.tsx when the page was redesigned. It is unchanged: ~150 lines of
 * banner-and-its-editor is not what the Features page is ABOUT, and leaving it inline meant the
 * shape of the page could not be read without scrolling past it.
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Pencil, Sparkles } from 'lucide-react'
import type { ExperimentalNotice as Notice } from '@/services/featuresService'

export function ExperimentalNoticeBanner({
  experimentalNotice,
  updateNotice,
  editNoticeOpen,
  setEditNoticeOpen,
}: {
  experimentalNotice: Notice | undefined
  updateNotice: (n: { enabled?: boolean; title?: string; message?: string }) => void
  editNoticeOpen: boolean
  setEditNoticeOpen: (open: boolean) => void
}) {
  const [editEnabled, setEditEnabled] = useState(true)
  const [editTitle, setEditTitle] = useState('')
  const [editMessage, setEditMessage] = useState('')

  const noticeEnabled = experimentalNotice?.enabled !== false

  // The editor can be opened from HERE (the pencil) or from the page header, which only flips the
  // flag. Seeding on the flag rather than in the click handler means both routes fill the fields —
  // the header button would otherwise open an empty editor and quietly blank the live notice on save.
  useEffect(() => {
    if (!editNoticeOpen) return
    setEditEnabled(experimentalNotice?.enabled !== false)
    setEditTitle(experimentalNotice?.title ?? '')
    setEditMessage(experimentalNotice?.message ?? '')
  }, [editNoticeOpen, experimentalNotice])

  const openEditNotice = () => setEditNoticeOpen(true)
  const saveEditNotice = () => {
    updateNotice({ enabled: editEnabled, title: editTitle || undefined, message: editMessage || undefined })
    setEditNoticeOpen(false)
  }

  return (
    <>
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
    </>
  )
}
