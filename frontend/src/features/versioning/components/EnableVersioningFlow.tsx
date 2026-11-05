/**
 * EnableVersioningFlow — the guided "turn on version control" modal.
 *
 * Two steps. The first says what version control MEANS for this data source before anyone
 * commits to it: what it gives, where changes come from once it is on, and the part people
 * miss — an upstream system (an ETL job, a connector) that keeps writing straight into the
 * graph. Its changes still show, but they stay out of version history until someone brings
 * them in, and history's own copy can be written back over them. The second step is the
 * pre-flight: how big the copy is, what happens while it runs, and the button that starts it.
 *
 * Enabling copies the entire graph into version history. That is a real, minutes-long
 * operation on a large model, so the user gets told what they're getting, how big the
 * copy is, and what happens while it runs — before they commit to it. (The old flow
 * was a bare button that fired a blocking request and showed a spinner.)
 *
 * Backdrop is a SIBLING of the pointer-events-none wrapper and never lives inside
 * AnimatePresence — the app's strand-proof modal invariant.
 */
import { useCallback, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Check, Database, Eye, EyeOff, GitBranch, History,
  Loader2, PenLine, Plug, Power, RotateCcw, ScanSearch, ShieldCheck, Sparkles, Upload, Workflow, X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { useBootstrapGraph } from '../hooks/useVersioning'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'

type Point = { Icon: LucideIcon; title: string; body: string }

const BENEFITS: Point[] = [
  {
    Icon: GitBranch,
    title: 'Edit safely in drafts',
    body: 'Your changes stay in a draft until you publish them. The live graph is never touched by a work-in-progress.',
  },
  {
    Icon: ShieldCheck,
    title: 'Review before anything ships',
    body: 'Raise a change for review, see exactly what moves, resolve conflicts, then merge.',
  },
  {
    Icon: History,
    title: 'Full history — and a way back',
    body: 'Every publish is a revision you can inspect, undo, or roll the whole graph back to.',
  },
]

/** The two ways a change reaches the graph once version control is on; the last stop is where it ends up. */
const LANES: { title: string; caption: string; good: boolean; stops: { Icon: LucideIcon; label: string }[] }[] = [
  {
    title: 'Changes made in this app',
    caption: 'Reviewed, recorded and reversible',
    good: true,
    stops: [
      { Icon: GitBranch, label: 'Draft' },
      { Icon: ShieldCheck, label: 'Review' },
      { Icon: Upload, label: 'Publish' },
      { Icon: History, label: 'In history' },
    ],
  },
  {
    title: 'Changes other tools write to the graph',
    caption: 'ETL jobs, connectors, scripts',
    good: false,
    stops: [
      { Icon: Plug, label: 'Upstream system' },
      { Icon: Database, label: 'Graph' },
      { Icon: Eye, label: 'Shows in views' },
      { Icon: EyeOff, label: 'Not in history' },
    ],
  },
]

// Each line is what the projector and Bring into history actually do to a customer's own graph
// (docs/versioning/04-projection-and-cache.md §7) — keep them in step with it.
const UPSTREAM_IMPACTS: Point[] = [
  {
    Icon: Eye,
    title: 'They still show in views',
    body: 'What an upstream system writes lands in the graph straight away, as it does today.',
  },
  {
    Icon: EyeOff,
    title: 'But they aren’t in version history',
    body: 'No draft, no review, no revision — so they can’t be compared, undone or rolled back.',
  },
  {
    Icon: RotateCcw,
    title: 'History’s copy can overwrite them',
    body: 'Publishing a change to the same item, or a Rebuild, writes history’s values back over an outside edit that was never brought in. A Rebuild also puts back items the tool removed.',
  },
  {
    Icon: ScanSearch,
    title: 'Not every change is flagged',
    body: 'The Versioning tab lists them under Not in history when the tool adds items or connections, or reports a change. An edit to existing fields that it doesn’t report isn’t counted.',
  },
]

const REMEDIES: Point[] = [
  {
    Icon: History,
    title: 'Bring into history',
    body: 'Someone who can publish takes what was written outside in as one published change. It adds and updates; it never removes anything from history.',
  },
  {
    Icon: Workflow,
    title: 'Write through this app instead',
    body: 'Point the upstream sync at this app’s API. Its changes then go into a draft — or straight to Published for a Publisher or Data engineer account — and into history.',
  },
]

const FACTS: Point[] = [
  {
    Icon: PenLine,
    title: 'Editing goes through drafts',
    body: 'Without version control this data source can only be read here. With it, every change is made in a draft, then published.',
  },
  {
    Icon: Power,
    title: 'It stays on',
    body: 'There’s no switch to turn it off for just this data source. An administrator can switch version control off for everyone; the history is kept.',
  },
  {
    Icon: Database,
    title: 'Your data stays as it is',
    body: 'Except duplicate identifiers you choose to collapse — removed for every data source that reads the graph — and items given a urn, which keep it.',
  },
]

const STEPS = [
  { id: 'explain', label: 'What it means' },
  { id: 'confirm', label: 'Turn it on' },
] as const
type Step = (typeof STEPS)[number]['id']

export function EnableVersioningFlow({
  open, onClose, wsId, dataSourceId, itemCount,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  dataSourceId: string
  /** Best-known size of the source graph (nodes + edges), for the pre-flight line. */
  itemCount?: number | null
}) {
  const { notify } = useAppNotifications()
  const bootstrap = useBootstrapGraph(wsId)
  const [step, setStep] = useState<Step>('explain')
  const [started, setStarted] = useState(false)
  const reason = useReasonDraft('versioning')

  // Every way out lands the next opening back on the explanation.
  const close = useCallback(() => {
    setStep('explain')
    onClose()
  }, [onClose])

  const start = () => {
    setStarted(true)
    bootstrap.mutate({ dataSourceId, reason: reason.take() }, {
      onSuccess: (res) => {
        close()
        notify(
          'success',
          res.alreadyEnabled
            ? 'Version control is already on for this data source.'
            : 'Copying your graph into version history — you can keep working while it runs.',
        )
      },
      onError: (e) => {
        setStarted(false)
        notify('error', e instanceof Error ? e.message : 'Could not start.')
      },
    })
  }

  const known = typeof itemCount === 'number' && itemCount > 0
  const size = known ? `about ${itemCount.toLocaleString()} items` : 'everything currently in this graph'
  // A rough bucket, never a number: the copy runs at very different speeds on different
  // providers, and the progress view times it properly from real throughput once it runs.
  const duration = !known ? 'large models can take a few minutes'
    : itemCount < 200_000 ? 'usually done in a couple of minutes'
    : itemCount < 2_000_000 ? 'usually done within half an hour'
    : 'a graph this size can take an hour or more'

  const dialogRef = useModalA11y(open, close)
  // The button that was pressed goes with the step it was on: focus the panel, as on opening.
  const goTo = (next: Step) => {
    setStep(next)
    dialogRef.current?.focus()
  }
  const busy = started || bootstrap.isPending

  return (
    <>
      <Backdrop open={open} onClick={close} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 pointer-events-none">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="enable-vc-title"
            aria-describedby="enable-vc-subtitle"
            tabIndex={-1}
            className="relative flex flex-col w-full max-w-2xl max-h-full bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border/70 overflow-hidden animate-fade-in pointer-events-auto outline-none"
          >
            <button
              onClick={close}
              aria-label="Close"
              className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-ink-muted/60 hover:text-ink hover:bg-canvas-overlay transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="shrink-0 px-6 pt-6 pb-4 border-b border-glass-border/70 bg-gradient-to-br from-indigo-500/[0.09] via-violet-500/[0.04] to-transparent">
              <div className="flex items-center gap-3 pr-8">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 shrink-0">
                  <GitBranch className="w-5 h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <h3 id="enable-vc-title" className="text-lg font-semibold text-ink font-display tracking-tight">Turn on version control</h3>
                  <p id="enable-vc-subtitle" className="text-[12px] text-ink-muted">
                    Drafts, reviews and full history for this data source — and what changes once it’s on.
                  </p>
                </div>
              </div>
              <StepTrack step={step} />
            </div>

            {/* Keyed by step: the next one starts at its top, not where the last was scrolled to. */}
            <div key={step} className="flex-1 min-h-0 overflow-y-auto px-6 py-5 animate-fade-in">
              {step === 'explain' ? <WhatItMeans /> : (
                <div className="space-y-4">
                  <section>
                    <SectionTitle>What happens when you turn it on</SectionTitle>
                    <div className="rounded-xl border border-glass-border/70 bg-canvas-overlay/40 px-4 py-3">
                      <p className="text-[12px] text-ink-secondary leading-relaxed">
                        We'll copy <span className="font-semibold text-ink">{size}</span> into version history and
                        check every item against the source before switching it on.
                      </p>
                      <p className="text-[12px] text-ink-secondary mt-1.5 leading-relaxed">
                        We check for duplicate identifiers first; nothing is copied until you decide.
                      </p>
                      <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed">
                        <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
                          <Check className="w-3 h-3" /> You can keep using this graph while it runs
                        </span>
                        {' · '}
                        {duration} · nothing changes until the check passes.
                      </p>
                    </div>
                  </section>

                  <p className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-[12px] text-ink-secondary leading-relaxed">
                    <AlertTriangle className="w-4 h-4 mt-px text-amber-600 dark:text-amber-400 shrink-0" aria-hidden />
                    <span>
                      From then on, changes an upstream system writes straight to this graph stay out of version
                      history until someone who can publish chooses <span className="font-medium text-ink">Bring into history</span>.
                    </span>
                  </p>

                  <ReasonField draft={reason} audience="workspace" disabled={started} />
                </div>
              )}
            </div>

            <div className="shrink-0 px-6 py-4 border-t border-glass-border/70 flex flex-wrap items-center justify-between gap-3 bg-canvas-overlay/40">
              {step === 'explain' ? (
                <>
                  <a
                    href="/guide/versioning-change-control#turn-on-version-control-for-a-data-source"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    Read the guide
                  </a>
                  <div className="flex items-center gap-3 ml-auto">
                    <button
                      onClick={close}
                      className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors"
                    >
                      Not now
                    </button>
                    <button
                      onClick={() => goTo('confirm')}
                      className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                    >
                      Continue
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    onClick={() => goTo('explain')}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-canvas-overlay transition-colors disabled:opacity-50"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                  </button>
                  <button
                    onClick={start}
                    disabled={busy}
                    className="ml-auto flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    Turn on version control
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function StepTrack({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.id === step)
  return (
    <ol className="mt-4 flex items-center gap-2" aria-label="Steps">
      {STEPS.map((s, i) => {
        const done = i < at
        const current = i === at
        return (
          <li key={s.id} className="flex items-center gap-2" aria-current={current ? 'step' : undefined}>
            {i > 0 && <span className={cn('w-8 h-px', done || current ? 'bg-indigo-500/50' : 'bg-glass-border/70')} aria-hidden />}
            <span
              className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0',
                done ? 'bg-emerald-500 text-white'
                  : current ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/30'
                    : 'border border-glass-border/70 text-ink-muted',
              )}
              aria-hidden
            >
              {done ? <Check className="w-3 h-3" /> : i + 1}
            </span>
            <span className={cn('text-[12px] font-medium', current ? 'text-ink' : 'text-ink-muted')}>{s.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{children}</h4>
}

function PointRow({ point: { Icon, title, body }, tone }: { point: Point; tone: 'accent' | 'amber' | 'neutral' }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          'mt-0.5 w-7 h-7 rounded-lg border flex items-center justify-center shrink-0',
          tone === 'accent' && 'bg-accent-lineage/10 border-accent-lineage/20 text-accent-lineage',
          tone === 'amber' && 'bg-amber-500/10 border-amber-500/25 text-amber-600 dark:text-amber-400',
          tone === 'neutral' && 'bg-canvas-overlay border-glass-border/70 text-ink-secondary',
        )}
      >
        <Icon className="w-3.5 h-3.5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink leading-snug">{title}</span>
        <span className="block mt-0.5 text-[12px] text-ink-muted leading-snug">{body}</span>
      </span>
    </li>
  )
}

function WhatItMeans() {
  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>What you get</SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-3">
          {BENEFITS.map((p) => <PointRow key={p.title} point={p} tone="accent" />)}
        </ul>
      </section>

      <section>
        <SectionTitle>Where changes come from once it’s on</SectionTitle>
        <div className="space-y-2.5">
          {LANES.map((lane) => (
            <div
              key={lane.title}
              className={cn(
                'rounded-xl border px-4 py-3',
                lane.good ? 'border-accent-lineage/20 bg-accent-lineage/[0.04]' : 'border-amber-500/25 bg-amber-500/[0.05]',
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-[13px] font-medium text-ink">{lane.title}</span>
                <span className="text-[11px] text-ink-muted">{lane.caption}</span>
              </div>
              <ol className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {lane.stops.map(({ Icon, label }, i) => {
                  const last = i === lane.stops.length - 1
                  return (
                    <li key={label} className="flex items-center gap-1.5">
                      {i > 0 && <ArrowRight className="w-3 h-3 text-ink-muted/50 shrink-0" aria-hidden />}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium',
                          !last ? 'border-glass-border/70 bg-canvas-elevated text-ink-secondary'
                            : lane.good ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" aria-hidden />
                        {label}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="enable-vc-upstream"
        className="rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.08] to-amber-500/[0.02] overflow-hidden"
      >
        <div className="flex items-start gap-3 px-4 pt-4">
          <span className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden />
          </span>
          <div className="min-w-0">
            <h4 id="enable-vc-upstream" className="text-[14px] font-semibold text-ink leading-snug">
              Updates from upstream systems aren’t synced into history
            </h4>
            <p className="mt-0.5 text-[12px] text-ink-secondary leading-relaxed">
              Version control records what changes through this app. If an ETL job, a connector or a script keeps
              writing to this data source’s graph directly, its changes go around drafts and reviews:
            </p>
          </div>
        </div>
        <ul className="grid gap-x-5 gap-y-4 sm:grid-cols-2 px-4 py-4">
          {UPSTREAM_IMPACTS.map((p) => <PointRow key={p.title} point={p} tone="amber" />)}
        </ul>
        <div className="border-t border-amber-500/20 bg-canvas-elevated/70 px-4 py-4">
          <SectionTitle>How to keep them in step</SectionTitle>
          <ul className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {REMEDIES.map((p) => <PointRow key={p.title} point={p} tone="accent" />)}
          </ul>
        </div>
      </section>

      <section>
        <SectionTitle>Good to know</SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-3">
          {FACTS.map((p) => <PointRow key={p.title} point={p} tone="neutral" />)}
        </ul>
      </section>
    </div>
  )
}
