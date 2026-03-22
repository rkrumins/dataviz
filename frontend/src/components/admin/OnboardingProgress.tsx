import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Server, Layers, Database, BookOpen, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface OnboardingProgressProps {
  providerCount: number
  catalogItemCount: number
  workspaceCount: number
  hasOntology: boolean
  onStageClick: (tab: string) => void
}

const STORAGE_KEY = 'synodic-onboarding-complete'

const stages = [
  { label: 'Provider', tab: 'connections', icon: Server },
  { label: 'Assets', tab: 'assets', icon: Layers },
  { label: 'Workspace', tab: 'workspaces', icon: Database },
  { label: 'Semantics', tab: 'workspaces', icon: BookOpen },
] as const

export function OnboardingProgress({
  providerCount,
  catalogItemCount,
  workspaceCount,
  hasOntology,
  onStageClick,
}: OnboardingProgressProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  const doneFlags = [
    providerCount > 0,
    catalogItemCount > 0,
    workspaceCount > 0,
    hasOntology,
  ]
  const doneCount = doneFlags.filter(Boolean).length
  const allDone = doneCount === 4

  useEffect(() => {
    if (allDone && !dismissed) {
      const timer = setTimeout(() => {
        try {
          localStorage.setItem(STORAGE_KEY, 'true')
        } catch {
          // ignore
        }
        setDismissed(true)
      }, 2500)
      return () => clearTimeout(timer)
    }
  }, [allDone, dismissed])

  if (dismissed) return null

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          initial={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.4, ease: 'easeInOut' }}
          className="glass-panel-subtle rounded-xl px-6 py-3 mb-4"
        >
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-ink-muted">
              {allDone ? 'All set!' : 'Setup Progress'}
            </span>
            <span className="text-[10px] text-ink-muted">
              {doneCount} of 4 done
            </span>
          </div>

          {/* Progress bar */}
          <div className="flex items-center">
            {stages.map((stage, i) => {
              const isDone = doneFlags[i]
              const _Icon = stage.icon
              const lineComplete = i < stages.length - 1 && doneFlags[i] && doneFlags[i + 1]

              return (
                <div key={stage.label} className="flex items-center flex-1 last:flex-none">
                  {/* Stage node */}
                  <div className="flex flex-col items-center">
                    <button
                      type="button"
                      disabled={isDone}
                      onClick={() => !isDone && onStageClick(stage.tab)}
                      className={cn(
                        'w-6 h-6 rounded-full flex items-center justify-center transition-colors',
                        isDone
                          ? 'bg-emerald-500 text-white'
                          : 'bg-slate-200 dark:bg-slate-700 text-ink-muted cursor-pointer hover:ring-2 hover:ring-indigo-400/40',
                      )}
                    >
                      {isDone ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <span className="text-[10px] font-semibold">{i + 1}</span>
                      )}
                    </button>
                    <span
                      className={cn(
                        'text-[10px] font-medium mt-1 whitespace-nowrap',
                        isDone
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-ink-muted cursor-pointer hover:text-indigo-500',
                      )}
                      onClick={() => !isDone && onStageClick(stage.tab)}
                    >
                      {stage.label}
                    </span>
                  </div>

                  {/* Connecting line */}
                  {i < stages.length - 1 && (
                    <div
                      className={cn(
                        'h-0.5 flex-1 mx-2 -mt-4 transition-colors',
                        lineComplete
                          ? 'bg-emerald-500'
                          : 'bg-slate-200 dark:bg-slate-700',
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
