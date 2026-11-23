/**
 * The view header's sync indicator: is what this view reads in sync with where it comes from?
 *
 * One pill — a two-node mark (where the data is kept → what the view reads) coloured by the
 * verdict, and a few words ("In sync · v11", "1 version behind", "Checked 40s ago"). Hover says
 * the headline; click opens the whole path as lanes joined by a rail, each lane with its version,
 * revision and times, the rail between two lanes showing whether they agree (solid), are catching
 * up (flowing) or have come apart (broken). Every word comes from `deriveSync`, so the pill, the
 * hover and the card cannot disagree. While the graph is updated and the server says how far it is
 * (`versioned.progress`), the pill adds the percentage and time left and the graph's lane shows the
 * update itself (`UpdateProgress`).
 *
 * The Business view opens a card too, in plain words: what kind of graph it is, the version saved
 * with its commit, the version on screen and the summaries. The Technical lanes, store names and
 * all, sit behind "Show technical details", which stays as the reader left it.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Copy, GitCommitHorizontal, Radar, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { timeAgo } from '@/lib/timeAgo'
import { Disclosure } from '@/components/ui/Disclosure'
import { HoverTip } from '@/components/ui/HoverTip'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { usePermission } from '@/store/auth'
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import type { GraphUpdateProgress } from '@/services/versioningApiService'
import { UpdateProgress } from '@/features/versioning/components/UpdateProgress'
import { describeProgress } from '@/features/versioning/components/updateProgressWords'
import { deriveSync, KIND_TEXT, shortRevision, type SyncLane, type SyncTone, type SyncVerdict } from './deriveSync'
import { useSyncStatus } from './useSyncStatus'

const TONE: Record<SyncTone, { pill: string; ink: string; dot: string; rail: string; ring: string }> = {
  ok: {
    pill: 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 hover:bg-emerald-500/[0.12] dark:text-emerald-300',
    ink: 'text-emerald-700 dark:text-emerald-300', dot: '#10b981', rail: 'bg-emerald-500/60', ring: 'ring-emerald-500/40 bg-emerald-500',
  },
  warn: {
    pill: 'border-amber-500/35 bg-amber-500/[0.08] text-amber-800 hover:bg-amber-500/[0.14] dark:text-amber-300',
    ink: 'text-amber-700 dark:text-amber-300', dot: '#f59e0b', rail: 'bg-amber-500/60', ring: 'ring-amber-500/40 bg-amber-500',
  },
  bad: {
    pill: 'border-rose-500/35 bg-rose-500/[0.08] text-rose-700 hover:bg-rose-500/[0.14] dark:text-rose-300',
    ink: 'text-rose-600 dark:text-rose-300', dot: '#f43f5e', rail: 'bg-rose-500/60', ring: 'ring-rose-500/40 bg-rose-500',
  },
  busy: {
    pill: 'border-indigo-500/30 bg-indigo-500/[0.07] text-indigo-700 hover:bg-indigo-500/[0.12] dark:text-indigo-300',
    ink: 'text-indigo-600 dark:text-indigo-300', dot: '#6366f1', rail: 'bg-indigo-500/50', ring: 'ring-indigo-500/40 bg-indigo-500',
  },
  idle: {
    pill: 'border-slate-400/30 bg-slate-400/[0.06] text-slate-600 hover:bg-slate-400/[0.12] dark:text-slate-300',
    ink: 'text-slate-600 dark:text-slate-300', dot: '#94a3b8', rail: 'bg-slate-400/40', ring: 'ring-slate-400/40 bg-slate-400',
  },
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const subscribeReducedMotion = (onChange: () => void) => {
  const mq = window.matchMedia?.(REDUCED_MOTION)
  mq?.addEventListener?.('change', onChange)
  return () => mq?.removeEventListener?.('change', onChange)
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia?.(REDUCED_MOTION).matches ?? false, () => false)
}

/** Two nodes and the link between them: solid (in sync), flowing (catching up), hollow far end
 *  (behind), broken (apart). */
function SyncMark({ tone, size = 14 }: { tone: SyncTone; size?: number }) {
  const reduce = useReducedMotion()
  const c = TONE[tone].dot
  const hollow = tone === 'warn' || tone === 'bad'
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="3" cy="7" r="2.3" fill={c} />
      {tone === 'bad' ? (
        <>
          <line x1="5.4" y1="7" x2="6.4" y2="7" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
          <line x1="7.8" y1="7" x2="8.6" y2="7" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : (
        <line x1="5.3" y1="7" x2="8.7" y2="7" stroke={c} strokeWidth="1.6" strokeLinecap="round"
          strokeDasharray={tone === 'busy' || tone === 'warn' ? '1.4 1.2' : undefined}>
          {tone === 'busy' && !reduce && (
            <animate attributeName="stroke-dashoffset" from="2.6" to="0" dur="0.8s" repeatCount="indefinite" />
          )}
        </line>
      )}
      <circle cx="11" cy="7" r={hollow ? 1.9 : 2.3} fill={hollow ? 'none' : c} stroke={c} strokeWidth={hollow ? 1.3 : 0} />
    </svg>
  )
}

/** A revision, short and copyable. `plain`: the Business view's — called a commit, with the full id
 *  in the app's tooltip rather than the browser's. */
function RevisionTag({ id, message, plain }: { id: string; message?: string | null; plain?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        }).catch(() => {})
      }}
      title={plain ? undefined : `Copy ${id}`}
      aria-label={plain ? `Copy commit ${id}` : `Copy revision ${id}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-glass-border bg-canvas-overlay px-1.5 py-px text-[10.5px] font-medium tabular-nums text-ink hover:border-indigo-400/60 transition-colors',
        plain && 'font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
      )}
    >
      {shortRevision(id)}
      {copied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5 text-ink-muted" />}
    </button>
  )
  return (
    <span className="mt-1 flex items-center gap-1.5 min-w-0">
      <span className="text-[10.5px] text-ink-muted shrink-0">{plain ? 'Commit' : 'Revision'}</span>
      {plain ? <HoverTip className="inline-flex" label={id} detail={copied ? 'Copied' : 'Click to copy'}>{copy}</HoverTip> : copy}
      {message && <span className="truncate text-[10.5px] text-ink-muted">“{message}”</span>}
    </span>
  )
}

function Lane({ lane, next, last, sameRevisionAsPrevious, update, plain }: {
  lane: SyncLane; next?: SyncLane; last: boolean; sameRevisionAsPrevious?: boolean
  /** The graph's lane: how far its update in flight is, in place of the lane's own bar. */
  update?: GraphUpdateProgress | null
  /** One of the Business view's plain lanes. */
  plain?: boolean
}) {
  const reduce = useReducedMotion()
  const t = TONE[lane.tone]
  // The rail below this lane shows how the NEXT lane stands against it.
  const railTone = next?.tone ?? lane.tone
  return (
    <li className="grid grid-cols-[18px_1fr] gap-x-3">
      <div className="flex flex-col items-center">
        <span className={cn('mt-1 h-2.5 w-2.5 rounded-full ring-4 shrink-0', t.ring)} aria-hidden />
        {!last && (
          railTone === 'bad' ? (
            <span className="flex-1 flex flex-col items-center gap-1 py-1" aria-hidden>
              <span className={cn('w-px flex-1', TONE.bad.rail)} />
              <span className="h-1.5" />
              <span className={cn('w-px flex-1', TONE.bad.rail)} />
            </span>
          ) : (
            <span
              aria-hidden
              className={cn('w-px flex-1 my-1', railTone === 'busy' || railTone === 'warn' ? '' : TONE[railTone].rail)}
              style={railTone === 'busy' || railTone === 'warn' ? {
                backgroundImage: `linear-gradient(to bottom, ${TONE[railTone].dot} 50%, transparent 50%)`,
                backgroundSize: '1px 6px',
                animation: railTone === 'busy' && !reduce ? 'nx-sync-flow 0.9s linear infinite' : undefined,
              } : undefined}
            />
          )
        )}
      </div>
      <div className={cn('min-w-0', last ? 'pb-0' : 'pb-4')}>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink">{lane.title}</span>
          {lane.tech && <span className="text-[10.5px] text-ink-muted">{lane.tech}</span>}
        </div>
        <div className={cn('mt-0.5 text-[12px] font-medium', t.ink)}>{lane.status}</div>
        {update ? <UpdateProgress progress={update} className="mt-2" />
          : lane.progress != null && <ProgressBar value={lane.progress} label={`${lane.title} progress`} className="mt-1.5" />}
        {lane.revision?.commitId && (
          sameRevisionAsPrevious
            ? <span className="mt-1 block text-[10.5px] text-ink-muted">{plain ? 'Same commit as the saved version' : 'Same revision as the system of record'}</span>
            : <RevisionTag id={lane.revision.commitId} message={lane.key === 'record' ? lane.revision.message : null} plain={plain} />
        )}
        {lane.lines.map((line) => (
          <p key={line} className="mt-0.5 text-[11px] leading-snug text-ink-muted">{line}</p>
        ))}
        {lane.next && (
          <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-ink">
            <ArrowRight className="mt-[2px] h-3 w-3 shrink-0 text-ink-muted" aria-hidden />
            <span>{lane.next}</span>
          </p>
        )}
      </div>
    </li>
  )
}

/** The path as lanes joined by a rail: the Technical card's list, and — plain — the Business card's.
 *  A graph lane on the revision of the lane before it says so rather than repeat the id. */
function Lanes({ lanes, update, plain, label }: {
  lanes: SyncLane[]; update: GraphUpdateProgress | null; plain?: boolean; label: string
}) {
  const record = lanes.find((l) => l.key === 'record')
  return (
    <ol className="px-4 pt-3.5 pb-3" aria-label={label}>
      {lanes.map((lane, i) => (
        <Lane
          key={lane.key}
          lane={lane}
          next={lanes[i + 1]}
          last={i === lanes.length - 1}
          sameRevisionAsPrevious={lane.key === 'graph' && !!record?.revision?.commitId
            && record.revision.commitId === lane.revision?.commitId}
          update={lane.key === 'graph' ? update : null}
          plain={plain}
        />
      ))}
    </ol>
  )
}

/**
 * The Business view's pill and card. The pill keeps its plain words (Up to date, Updating, May be
 * out of date); the card says what kind of graph this is, the version saved with its commit, what
 * views show and the summaries — no store names. The Technical lanes are one click further, behind
 * a toggle that stays as the reader left it.
 */
function BusinessSyncChip({ verdict, q, update, canManage, onOpenHealth, className }: {
  verdict: SyncVerdict
  q: ReturnType<typeof useSyncStatus>
  update: GraphUpdateProgress | null
  canManage: boolean
  onOpenHealth: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const showTechnical = usePreferencesStore((s) => s.syncTechnicalDetailsOpen)
  const setShowTechnical = usePreferencesStore((s) => s.setSyncTechnicalDetailsOpen)
  // Opened, the details start below the card's fold: bring them up rather than leave the reader
  // wondering whether the click did anything.
  const technicalRef = useRef<HTMLDivElement>(null)
  const toggleTechnical = (next: boolean) => {
    setShowTechnical(next)
    if (next) requestAnimationFrame(() => technicalRef.current?.scrollIntoView({ block: 'start' }))
  }
  const t = TONE[verdict.tone]
  const howFar = update ? describeProgress(update) : null
  // An earlier version on screen while the newer one is written is said as such, with which and
  // until when on hover: the view is complete, only not the newest yet. How far the newer one is,
  // once the server says.
  const updating = verdict.tone === 'busy' && update
  const words = verdict.showingOlder
    ? verdict.tone === 'busy'
      ? updating && howFar?.bare
        ? <>Showing an earlier version · <UpdateProgress progress={update} variant="chip" withVersion={false} /></>
        : 'Showing an earlier version · updating…'
      : 'Showing an earlier version'
    : verdict.tone === 'busy' ? updating ? <UpdateProgress progress={update} variant="chip" /> : 'Updating…'
    : verdict.tone === 'ok' ? `Up to date · checked ${timeAgo(q.data!.checkedAt)}`
    : verdict.tone === 'idle' ? verdict.chip
    : 'May be out of date'
  const kind = verdict.kind
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HoverTip
        className={cn('inline-flex', className)}
        label={verdict.plain.headline}
        detail={open ? undefined : `${verdict.plain.detail}${verdict.plain.detail ? ' · ' : ''}Click for details`}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Sync status: ${verdict.kindLabel ? `${verdict.kindLabel}, ` : ''}${verdict.plain.headline}${howFar ? `. ${howFar.sentence}` : ''}`}
            className={cn(
              'inline-flex items-center gap-1.5 h-5 px-2 rounded-full border text-[11px] font-medium leading-none whitespace-nowrap transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
              t.pill,
            )}
          >
            <SyncMark tone={verdict.tone} size={13} />
            <span className="inline-flex min-w-0 items-center gap-1">{words}</span>
          </button>
        </Popover.Trigger>
      </HoverTip>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          aria-label="Sync details"
          // Focus the card, not its first control: on Check again, its tip would open with the
          // card every time. Tab still reaches every control from here.
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus() }}
          // Bound to the room the viewport leaves, scrolling inside: with the technical details
          // open the card is taller than a laptop screen below the header.
          className="z-50 flex w-[360px] max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden rounded-2xl outline-none border border-glass-border bg-canvas-elevated shadow-xl"
        >
          <style>{'@keyframes nx-sync-flow { from { background-position: 0 0 } to { background-position: 0 6px } }'}</style>
          <div className="flex shrink-0 items-start gap-3 px-4 pt-4 pb-3 border-b border-glass-border">
            <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl border shrink-0', t.pill)}>
              <SyncMark tone={verdict.tone} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13.5px] font-semibold text-ink leading-tight">{verdict.plain.headline}</h3>
              {verdict.plain.detail && <p className="mt-0.5 text-[11.5px] text-ink-muted leading-snug">{verdict.plain.detail}</p>}
            </div>
            <HoverTip label="Check again">
              <button
                type="button"
                onClick={() => void q.refetch()}
                aria-label="Check again"
                className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-canvas-overlay transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} aria-hidden />
              </button>
            </HoverTip>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {kind && (
              <div className="flex items-start gap-2.5 px-4 py-3 border-b border-glass-border bg-canvas-overlay">
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-lg shrink-0',
                  kind === 'versioned' ? 'bg-violet-500/10 text-violet-600 dark:text-violet-300' : 'bg-sky-500/10 text-sky-600 dark:text-sky-300')}>
                  {kind === 'versioned'
                    ? <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
                    : <Radar className="h-3.5 w-3.5" aria-hidden />}
                </span>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-ink leading-tight">{verdict.kindLabel}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{KIND_TEXT[kind].plain}</p>
                </div>
              </div>
            )}

            <Lanes lanes={verdict.plain.lanes} update={update} plain label="How up to date this view is" />

            {verdict.lanes.length > 0 && (
              <div ref={technicalRef} className="border-t border-glass-border">
                <Disclosure
                  open={showTechnical}
                  onOpenChange={toggleTechnical}
                  buttonClassName="px-4 py-2.5 text-[11.5px] font-medium text-ink-secondary hover:text-ink hover:bg-canvas-overlay transition-colors"
                  summary={showTechnical ? 'Hide technical details' : 'Show technical details'}
                >
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={MOTION.fadeIn}>
                    <p className="px-4 pt-1 text-[11px] leading-snug text-ink-muted">{verdict.kindExplainer}</p>
                    <Lanes lanes={verdict.lanes} update={update} label="Where this view's data comes from" />
                  </motion.div>
                </Disclosure>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2.5 border-t border-glass-border">
            <span className="text-[10.5px] text-ink-muted">
              {q.data ? `Checked ${timeAgo(q.data.checkedAt)}` : 'Checking…'}
              {verdict.busy ? ' · updating live' : ''}
            </span>
            {kind === 'versioned' && canManage && (
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenHealth() }}
                className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
              >
                Open Data health
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function SyncStatusChip({ workspaceId, dataSourceId, viewId, className }: {
  workspaceId: string; dataSourceId: string; viewId?: string; className?: string
}) {
  const q = useSyncStatus(workspaceId, dataSourceId, viewId)
  const [open, setOpen] = useState(false)
  // Re-derive every 15s so "checked 40s ago" ages while the card sits open between polls.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  const canManage = usePermission('workspace:datasource:manage', workspaceId)
  const openPanel = useVersioningPanelStore((s) => s.openPanel)
  const technical = usePersonaMode() === 'technical'

  // Memoised: the header re-renders with the canvas, and the verdict formats dates and numbers.
  const verdict = useMemo(() => deriveSync(q.data, now), [q.data, now])
  if (q.isError && !q.data) return null        // not readable here — say nothing rather than guess
  const t = TONE[verdict.tone]
  // How far the graph's update in flight is, when the server can say (null otherwise).
  const update = q.data?.versioned?.progress ?? null
  const howFar = update ? describeProgress(update) : null

  // The Business view keeps the verdict in words a reader acts on; its card keeps the store names
  // and revisions behind a toggle.
  if (!technical) {
    return <BusinessSyncChip verdict={verdict} q={q} update={update} canManage={canManage}
      onOpenHealth={() => openPanel('health')} className={className} />
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HoverTip
        className={cn('inline-flex', className)}
        label={verdict.kindLabel ? `${verdict.kindLabel} · ${verdict.headline}` : verdict.headline}
        detail={open ? undefined : `${verdict.detail}${verdict.detail ? ' · ' : ''}Click for details`}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Sync status: ${verdict.kindLabel ? `${verdict.kindLabel}, ` : ''}${verdict.headline}${howFar ? `. ${howFar.sentence}` : ''}`}
            className={cn(
              'inline-flex items-center gap-1.5 h-5 px-2 rounded-full border text-[11px] font-medium leading-none whitespace-nowrap transition-colors',
              t.pill,
            )}
          >
            <SyncMark tone={verdict.tone} size={13} />
            <span>{verdict.chip}</span>
            {howFar?.bare && verdict.busy && (
              <>
                <span aria-hidden>·</span>
                <UpdateProgress progress={update} variant="chip" withVersion={false} />
              </>
            )}
          </button>
        </Popover.Trigger>
      </HoverTip>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="z-50 w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-glass-border bg-canvas-elevated shadow-xl"
        >
          <style>{'@keyframes nx-sync-flow { from { background-position: 0 0 } to { background-position: 0 6px } }'}</style>
          <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-glass-border">
            <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl border shrink-0', t.pill)}>
              <SyncMark tone={verdict.tone} size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[13.5px] font-semibold text-ink leading-tight">{verdict.headline}</h3>
              {verdict.detail && <p className="mt-0.5 text-[11.5px] text-ink-muted leading-snug">{verdict.detail}</p>}
            </div>
            <button
              type="button"
              onClick={() => void q.refetch()}
              aria-label="Check again"
              title="Check again"
              className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-canvas-overlay transition-colors"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
            </button>
          </div>

          {verdict.kind && (
            <div className="flex items-start gap-2 px-4 py-2.5 border-b border-glass-border bg-canvas-overlay">
              {verdict.kind === 'versioned'
                ? <GitCommitHorizontal className="mt-[1px] h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden />
                : <Radar className="mt-[1px] h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden />}
              <p className="text-[11px] leading-snug text-ink-muted">
                <span className="font-semibold text-ink">{verdict.kindLabel}.</span> {verdict.kindExplainer}
              </p>
            </div>
          )}

          <Lanes lanes={verdict.lanes} update={update} label="Where this view's data comes from" />

          <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-glass-border">
            <span className="text-[10.5px] text-ink-muted">
              {q.data ? `Status read ${timeAgo(q.data.checkedAt)}` : 'Reading status…'}
              {verdict.busy ? ' · updating live' : ''}
            </span>
            {q.data?.kind === 'versioned' && canManage && (
              <button
                type="button"
                onClick={() => { setOpen(false); openPanel('health') }}
                className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
              >
                Open Data health
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
