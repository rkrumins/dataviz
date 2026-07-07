/**
 * UnsavedWorkGuard — centralized guard against silently losing staged canvas
 * edits. Mounted once alongside CanvasRouter (in ViewPage) so a single guard
 * covers every canvas type it renders (GraphCanvas, HierarchyCanvas,
 * ReferenceModelCanvas), driven by the staged-changes store — the source of
 * truth for "is there unsaved work right now?".
 *
 * Two leave paths are covered:
 *  - Browser-level unload (refresh / close tab / hard navigation) — arms the
 *    native `beforeunload` prompt via useUnsavedChangesWarning. That dialog
 *    is browser-chrome and cannot be styled.
 *  - In-app navigation (SPA route change) — the app router is a data router
 *    (createBrowserRouter, see routes.tsx), so `useBlocker` intercepts
 *    navigate()/<Link>/back-forward transitions before they commit, and this
 *    renders a styled confirmation dialog in their place.
 */
import { useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning'
import { useStagedChangeCount, useStagedChangesStore } from '@/store/stagedChangesStore'

export function UnsavedWorkGuard() {
  const stagedCount = useStagedChangeCount()
  const hasUnsavedWork = stagedCount > 0

  useUnsavedChangesWarning(hasUnsavedWork)

  // Block route changes only — same-path param/hash churn (tab switches,
  // filter state, etc.) must not trigger a "leave?" prompt.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!hasUnsavedWork) return false
    return currentLocation.pathname !== nextLocation.pathname
  })

  const isBlocked = blocker.state === 'blocked'
  const stayButtonRef = useRef<HTMLButtonElement>(null)

  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset()
  }
  const leave = () => {
    if (blocker.state !== 'blocked') return
    // "They'll be lost if you leave" must be true: discard the staged changes
    // (running their discard hooks, which restore the canvas's optimistic
    // state) BEFORE proceeding — otherwise they'd linger in the store and
    // silently re-arm the guard on the next view sharing the same scope.
    // Same order as OntologySchemaPage's blocker (discardChanges → proceed).
    useStagedChangesStore.getState().discardAll()
    blocker.proceed()
  }

  // Escape stays on the page — single, predictable escape (matches StagedChangesPanel).
  useEffect(() => {
    if (!isBlocked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        stay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBlocked])

  useEffect(() => {
    if (isBlocked) stayButtonRef.current?.focus()
  }, [isBlocked])

  return (
    <>
      <Backdrop open={isBlocked} onClick={stay} zClassName="z-[90]" />
      <div className="fixed inset-0 z-[91] flex items-center justify-center px-4 pointer-events-none">
        <AnimatePresence>
          {isBlocked && (
            <motion.div
              key="unsaved-work-guard-dialog"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.12 }}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="unsaved-work-guard-title"
              className="pointer-events-auto relative w-full max-w-sm rounded-2xl glass-panel bg-canvas-elevated/95 overflow-hidden"
            >
              <div className="px-6 pt-6 pb-5">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="min-w-0">
                    <h3 id="unsaved-work-guard-title" className="text-base font-display font-bold text-ink">
                      Leave without saving?
                    </h3>
                    <p className="text-sm text-ink-muted mt-1 leading-relaxed">
                      You have {stagedCount} unsaved change{stagedCount === 1 ? '' : 's'} — they'll be lost if you leave.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-6 pb-6">
                <button
                  onClick={leave}
                  className="btn btn-ghost btn-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20"
                >
                  Leave anyway
                </button>
                <button ref={stayButtonRef} onClick={stay} className="btn btn-primary btn-md">
                  Stay and keep editing
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}
