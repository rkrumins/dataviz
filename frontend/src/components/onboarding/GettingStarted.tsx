/**
 * GettingStarted — the unified onboarding hub.
 *
 * A role-aware, track-based guide: each track (Set up / Explore / Collaborate)
 * groups a few high-signal steps, shows its own progress, and carries its own
 * accent so the path reads at a glance. State comes from
 * ``useOnboardingProgress`` (real app data + click-completed "learn" steps), so
 * steps tick themselves off as the user works. The product tour sits at the
 * bottom as a persistent, replayable action — not a one-off step.
 */
import { motion } from 'framer-motion'
import { Link as RouterLink } from 'react-router-dom'
import { Check, ArrowRight, Sparkles, PlayCircle, PartyPopper } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBrand } from '@/store/branding'
import { interpolateBrand } from '@/lib/brandText'
import { recordEvent } from '@/services/telemetryService'
import { useFeature } from '@/store/features'
import { useTourStore } from '@/features/tour/tourStore'
import { usePreferencesStore } from '@/store/preferences'
import { DocsLink } from '@/components/help/DocsLink'
import {
  useOnboardingProgress,
  GETTING_STARTED_TOUR,
  type OnboardingStep,
  type OnboardingTrack,
  type OnboardingAccent,
} from '@/hooks/useOnboardingProgress'

interface GettingStartedProps {
  /** Called after a step CTA fires — lets a host drawer/popover close itself. */
  onNavigate?: () => void
}

// Per-track palette. Static class strings so Tailwind keeps them.
const ACCENT: Record<OnboardingAccent, {
  tile: string; bar: string; ring: string; nextDot: string; nextRow: string; nextBtn: string
}> = {
  setup: {
    tile: 'bg-emerald-500/12 text-emerald-500',
    bar: 'bg-emerald-500',
    ring: 'text-emerald-500',
    nextDot: 'bg-emerald-500 text-white',
    nextRow: 'border-emerald-500/40 bg-emerald-500/[0.06]',
    nextBtn: 'bg-emerald-500 hover:bg-emerald-600 text-white',
  },
  explore: {
    tile: 'bg-indigo-500/12 text-indigo-500',
    bar: 'bg-indigo-500',
    ring: 'text-indigo-500',
    nextDot: 'bg-indigo-500 text-white',
    nextRow: 'border-indigo-500/40 bg-indigo-500/[0.06]',
    nextBtn: 'bg-indigo-500 hover:bg-indigo-600 text-white',
  },
  govern: {
    tile: 'bg-violet-500/12 text-violet-500',
    bar: 'bg-violet-500',
    ring: 'text-violet-500',
    nextDot: 'bg-violet-500 text-white',
    nextRow: 'border-violet-500/40 bg-violet-500/[0.06]',
    nextBtn: 'bg-violet-500 hover:bg-violet-600 text-white',
  },
}

export function GettingStarted({ onNavigate }: GettingStartedProps = {}) {
  const brand = useBrand()
  const { tracks, completedCount, total, allDone, isLoading } = useOnboardingProgress()
  const toursEnabled = useFeature('toursEnabled')
  const tourDone = useTourStore((s) => s.completed.includes(GETTING_STARTED_TOUR))
  const completeStep = usePreferencesStore((s) => s.completeOnboardingStep)

  const pct = total > 0 ? (completedCount / total) * 100 : 0
  // The single "next" step across every track — the one thing to do right now.
  const nextStepId = tracks.flatMap((t) => t.steps).find((s) => !s.done)?.id ?? null

  const onStepAction = (step: OnboardingStep) => {
    recordEvent('onboarding.step', { step: step.id })
    // "Learn" steps have no server signal — count acting on them as done.
    if (step.manual) completeStep(step.id)
    onNavigate?.()
  }

  const startTour = () => {
    useTourStore.getState().start(GETTING_STARTED_TOUR)
    onNavigate?.()
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      aria-labelledby="getting-started-title"
      className="glass-panel w-full max-w-xl rounded-2xl p-6"
    >
      {/* Header + overall progress */}
      <header className="mb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-lineage/12 text-accent-lineage">
            <Sparkles className="h-4 w-4" />
          </span>
          <h2 id="getting-started-title" className="text-base font-bold text-ink">Getting started</h2>
        </div>
        <p className="mt-1.5 text-sm text-ink-secondary">
          {interpolateBrand('A guided path to getting the most out of {brand}.', brand)}
        </p>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs font-medium">
            <span className="text-ink-secondary">{allDone ? 'Complete' : 'Your progress'}</span>
            <span className="text-ink-muted tabular-nums">{completedCount} of {total}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-canvas-overlay">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(2, pct)}%` }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
            />
          </div>
        </div>
      </header>

      {allDone && (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="mb-4 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3.5"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500">
            <PartyPopper className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-sm font-bold text-ink">You're all set 🎉</p>
            <p className="text-xs text-ink-secondary">
              {interpolateBrand("You've completed every step. Replay the tour any time below.", brand)}
            </p>
          </div>
        </motion.div>
      )}

      {/* Tracks */}
      {!isLoading && !allDone && (
        <div className="flex flex-col gap-5">
          {tracks.map((track, ti) => (
            <TrackSection
              key={track.id}
              track={track}
              index={ti}
              nextStepId={nextStepId}
              isLoading={isLoading}
              onStepAction={onStepAction}
            />
          ))}
        </div>
      )}

      {/* Product tour — persistent, replayable. */}
      {toursEnabled && (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-glass-border bg-canvas-elevated/40 p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
            <PlayCircle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Product tour</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {tourDone ? 'Replay the guided walkthrough any time.' : 'A two-minute guided walkthrough of the workspace.'}
            </p>
          </div>
          <button type="button" onClick={startTour} className="btn-secondary btn-sm shrink-0">
            <PlayCircle className="h-4 w-4" />
            {tourDone ? 'Replay' : 'Start'}
          </button>
        </div>
      )}
    </motion.section>
  )
}

interface TrackSectionProps {
  track: OnboardingTrack
  index: number
  nextStepId: string | null
  isLoading: boolean
  onStepAction: (step: OnboardingStep) => void
}

function TrackSection({ track, index, nextStepId, isLoading, onStepAction }: TrackSectionProps) {
  const a = ACCENT[track.accent]
  const TrackIcon = track.icon
  const tpct = track.total > 0 ? (track.completedCount / track.total) * 100 : 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 * index, duration: 0.3, ease: 'easeOut' }}
    >
      {/* Track header */}
      <div className="mb-2 flex items-center gap-2.5">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', a.tile)}>
          <TrackIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-ink">{track.title}</h3>
            {track.allDone && <Check className={cn('h-3.5 w-3.5', a.ring)} />}
          </div>
          <p className="truncate text-2xs text-ink-muted">{track.subtitle}</p>
        </div>
        <span className="shrink-0 text-2xs font-semibold text-ink-muted tabular-nums">
          {track.completedCount}/{track.total}
        </span>
      </div>

      {/* Track mini progress */}
      <div className="mb-2.5 ml-9 h-1 overflow-hidden rounded-full bg-canvas-overlay">
        <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', a.bar)} style={{ width: `${Math.max(3, tpct)}%` }} />
      </div>

      {/* Steps */}
      <ol className="flex flex-col gap-1.5">
        {track.steps.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            index={i}
            accent={track.accent}
            isNext={step.id === nextStepId}
            isLoading={isLoading}
            onAction={() => onStepAction(step)}
          />
        ))}
      </ol>
    </motion.div>
  )
}

interface StepRowProps {
  step: OnboardingStep
  index: number
  accent: OnboardingAccent
  isNext: boolean
  isLoading: boolean
  onAction: () => void
}

function StepRow({ step, accent, isNext, isLoading, onAction }: StepRowProps) {
  const a = ACCENT[accent]
  const StepIcon = step.icon

  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 transition-colors',
        isNext ? a.nextRow : 'border-glass-border bg-canvas-elevated/40',
        step.done && 'opacity-70',
      )}
    >
      {/* Status */}
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors',
          step.done ? 'bg-emerald-500 text-white' : isNext ? a.nextDot : 'bg-canvas-overlay text-ink-muted',
        )}
        aria-hidden="true"
      >
        {step.done ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
      </span>

      {/* Copy */}
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-semibold text-ink', step.done && 'text-ink-secondary line-through decoration-ink-muted/40')}>
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

      {/* CTA — actionable while outstanding. */}
      {!step.done && (
        <div className="shrink-0 self-center">
          <RouterLink
            to={step.href ?? '#'}
            onClick={onAction}
            aria-label={`${step.label} — open`}
            className={cn(
              'btn-sm',
              // Accent the "next" step: base primary-button layout with the
              // track colour layered on (utilities beat the component layer).
              isNext ? ['btn-primary', a.nextBtn] : 'btn-secondary',
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
