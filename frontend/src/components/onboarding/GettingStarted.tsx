/**
 * GettingStarted — the unified onboarding hub.
 *
 * One checklist that shows a new user exactly where they are across the
 * first-run journey (connect a provider → discover assets → workspace →
 * ontology → view), replacing the fragmented first-run surfaces. State comes
 * from ``useOnboardingProgress`` (real app data), so a step ticks itself off
 * the moment the user completes it elsewhere. The product tour sits below the
 * checklist as a persistent action (when enabled) so it can be replayed any
 * time — it is not a one-off step that vanishes once taken.
 */
import { motion } from 'framer-motion'
import { Link as RouterLink } from 'react-router-dom'
import { Check, ArrowRight, Sparkles, PlayCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBrand } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { recordEvent } from '@/services/telemetryService'
import { useFeature } from '@/store/features'
import { useTourStore } from '@/features/tour/tourStore'
import { DocsLink } from '@/components/help/DocsLink'
import { ProgressBar } from '@/components/ui/ProgressBar'
import {
  useOnboardingProgress,
  GETTING_STARTED_TOUR,
  type OnboardingStep,
} from '@/hooks/useOnboardingProgress'

interface GettingStartedProps {
  /** Called after a step CTA fires — lets a host drawer/popover close itself. */
  onNavigate?: () => void
}

export function GettingStarted({ onNavigate }: GettingStartedProps = {}) {
  const brand = useBrand()
  const { steps, completedCount, total, allDone, isLoading } = useOnboardingProgress()
  const toursEnabled = useFeature('toursEnabled')
  const tourDone = useTourStore((s) => s.completed.includes(GETTING_STARTED_TOUR))

  // The first not-yet-done step is the user's "next" — emphasised below.
  const nextStepId = steps.find((s) => !s.done)?.id ?? null
  const pct = total > 0 ? (completedCount / total) * 100 : 0

  const handleStepAction = (step: OnboardingStep) => {
    recordEvent('onboarding.step', { step: step.id })
    onNavigate?.()
  }

  const handleStartTour = () => {
    useTourStore.getState().start(GETTING_STARTED_TOUR)
    onNavigate?.()
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      aria-labelledby="getting-started-title"
      className="glass-panel rounded-2xl p-6 w-full max-w-xl"
    >
      {/* Header */}
      <header className="mb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-lineage/10 text-accent-lineage">
            <Sparkles className="h-4 w-4" />
          </span>
          <h2 id="getting-started-title" className="text-base font-bold text-ink">
            Getting started
          </h2>
        </div>
        <p className="mt-1.5 text-sm text-ink-secondary">
          {interpolateBrand('A few steps to get the most out of {brand}', brand)}
        </p>
      </header>

      {/* Progress */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between text-xs font-medium">
          <span className="text-ink-secondary">
            {allDone ? 'Complete' : 'Your progress'}
          </span>
          <span className="text-ink-muted tabular-nums" aria-hidden="true">
            {completedCount} of {total}
          </span>
        </div>
        <ProgressBar
          value={pct}
          label={`Onboarding progress: ${completedCount} of ${total} steps complete`}
        />
      </div>

      {allDone ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-5 text-center"
        >
          <p className="text-lg font-bold text-ink">All set 🎉</p>
          <p className="mt-1 text-sm text-ink-secondary">
            {interpolateBrand("You're ready to explore {brand}.", brand)}
          </p>
        </motion.div>
      ) : (
        <ol className="flex flex-col gap-2">
          {steps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              index={i}
              isNext={step.id === nextStepId}
              isLoading={isLoading}
              onAction={() => handleStepAction(step)}
            />
          ))}
        </ol>
      )}

      {/* Product tour — a persistent action (not a one-off step), so it can be
          replayed any time. Only shown when the experimental flag is on. */}
      {toursEnabled && (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-glass-border bg-canvas-elevated/40 p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
            <PlayCircle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Product tour</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {tourDone
                ? 'Replay the guided walkthrough any time.'
                : 'A two-minute guided walkthrough of the workspace.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleStartTour}
            className="btn-secondary btn-sm shrink-0"
          >
            <PlayCircle className="h-4 w-4" />
            {tourDone ? 'Replay' : 'Start'}
          </button>
        </div>
      )}
    </motion.section>
  )
}

interface StepRowProps {
  step: OnboardingStep
  index: number
  isNext: boolean
  isLoading: boolean
  onAction: () => void
}

function StepRow({ step, index, isNext, isLoading, onAction }: StepRowProps) {
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 transition-colors',
        isNext
          ? 'border-accent-lineage/40 bg-accent-lineage/[0.06]'
          : 'border-glass-border bg-canvas-elevated/40',
        step.done && 'opacity-70',
      )}
    >
      {/* Status indicator */}
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
          step.done
            ? 'bg-emerald-500 text-white'
            : isNext
              ? 'bg-accent-lineage text-white'
              : 'bg-canvas-overlay text-ink-muted',
        )}
        aria-hidden="true"
      >
        {step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}
      </span>

      {/* Copy */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm font-semibold text-ink',
            step.done && 'text-ink-secondary line-through decoration-ink-muted/40',
          )}
        >
          {step.label}
          {step.done && <span className="sr-only"> (completed)</span>}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">{step.description}</p>
        {step.guideSlug && !step.done && (
          <div className="mt-2">
            <DocsLink slug={step.guideSlug} className="text-xs" />
          </div>
        )}
      </div>

      {/* CTA — only actionable while the step is outstanding. */}
      {!step.done && (
        <div className="shrink-0 self-center">
          <RouterLink
            to={step.href ?? '#'}
            onClick={onAction}
            aria-label={`${step.label} — open`}
            className={cn(
              isNext ? 'btn-primary' : 'btn-secondary',
              'btn-sm',
              isLoading && 'pointer-events-none opacity-50',
            )}
          >
            Open
            <ArrowRight className="h-4 w-4" />
          </RouterLink>
        </div>
      )}
    </li>
  )
}
