/**
 * DigestSheet — what changed in the graph since you last looked: the versions published since your
 * seen marker (or in the last 7 days, said so), who published them and what each recorded of
 * itself, the reviews waiting on you, and the entities you watch that changed. From each, the way
 * on: a version's changes in place (`ChangeList`), its comparison in History (`RevisionCompare`),
 * a watched entity's history (`EntityHistory`), a review in the Reviews inbox.
 *
 * Opening it marks nothing seen. It is a list to work through — a comparison opened from it, and the
 * way back, must find it as it was — and "seen" is kept by the server for every device, so a glance
 * must not clear what is new on the next. "Mark as seen" says so, for the version the sheet shows.
 *
 * Every figure is the server's: a count a version didn't record is "—", never 0.
 */
import { useId, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Bot, CheckCheck, CheckCircle2, ChevronRight, Eye, GitCompareArrows,
  GitPullRequestArrow, History, Info, ListTree, Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { Drawer } from '@/components/ui/Drawer'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonChip } from '@/components/ui/PersonChip'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { useAuthStore } from '@/store/auth'
import type { DigestCounts, DigestPerson, DigestVersion, DigestWatched } from '@/services/versioningApiService'
import { useGraphDigest, useMarkDigestSeen } from '../hooks/useDigest'
import { kindMeta } from '../model/commitKind'
import { ChangeList } from './ChangeList'
import { EntityHistory } from './EntityHistory'
import { NodeDiffBadge } from './NodeDiffBadge'

/** Readable in both themes at 11 px (the diff tints' 500 steps are not, on white). */
const COUNT_TONE = {
  added: 'text-emerald-700 dark:text-emerald-400',
  modified: 'text-amber-700 dark:text-amber-400',
  removed: 'text-rose-700 dark:text-rose-400',
} as const

/** A watched entity's change, in the diff vocabulary every change surface uses. */
const CHANGE_STATUS: Record<DigestWatched['change'], keyof typeof COUNT_TONE> = {
  added: 'added', changed: 'modified', removed: 'removed',
}

/** What the version kinds say in this list: the commit kinds, in words a reader uses. */
const KIND_WORD: Record<string, string> = {
  squash_publish: 'Published', revert: 'Undone', restore: 'Restored', import: 'Imported',
  sync: 'Synced', sync_parent: 'From parent', genesis: 'Started', edit: 'Edited',
}

function who(p: DigestPerson, me: string | null): string {
  if (!p.id) return 'The platform'
  if (p.id === me) return 'You'
  return p.name || p.id
}

/** A version's counts, or "—" where it recorded none. */
function Counts({ counts }: { counts: DigestCounts | null }) {
  if (!counts) {
    return (
      <HoverTip className="inline-flex" label="Not recorded"
        detail="This version didn't record how many entities it changed. Compare it to see its changes.">
        <span className="text-[11px] font-medium text-ink-muted tabular-nums">
          <span aria-hidden>—</span><span className="sr-only">Changes not recorded</span>
        </span>
      </HoverTip>
    )
  }
  const parts = [
    { status: 'added' as const, n: counts.added, word: 'added' },
    { status: 'modified' as const, n: counts.changed, word: 'modified' },
    { status: 'removed' as const, n: counts.removed, word: 'removed' },
  ].filter((p) => p.n > 0)
  if (parts.length === 0) return <span className="text-[11px] text-ink-muted">No entities changed</span>
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">{parts.map((p) => `${formatCount(p.n)} ${p.word}`).join(', ')}</span>
      {parts.map((p) => (
        <span key={p.status} aria-hidden>
          <NodeDiffBadge status={p.status} count={p.n} className={COUNT_TONE[p.status]} />
        </span>
      ))}
    </span>
  )
}

function Section({ icon: Icon, title, count, children }: {
  icon: ComponentType<{ className?: string }>
  title: string
  count?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
        <Icon className="w-3.5 h-3.5" aria-hidden />
        {title}
        {count != null && <span className="font-medium normal-case tracking-normal text-ink-muted/80">· {count}</span>}
      </h3>
      {children}
    </section>
  )
}

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <HoverTip className="flex min-w-0" label={label} detail={detail}>
      <div className="w-full min-w-0 rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.03] px-3 py-2">
        <p className="text-[11px] text-ink-muted truncate">{label}</p>
        <p className="mt-0.5 text-lg font-semibold leading-tight text-ink tabular-nums">{value}</p>
        <p className="sr-only">{detail}</p>
      </div>
    </HoverTip>
  )
}

function Expander({ open, onToggle, controls, icon: Icon, label }: {
  open: boolean
  onToggle: () => void
  controls: string
  icon: ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
    >
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {label}
      <ChevronRight className={cn('w-3 h-3 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
    </button>
  )
}

function VersionRow({ v, wsId, graphId, me, onCompare }: {
  v: DigestVersion
  wsId: string
  graphId: string
  me: string | null
  onCompare: (fromSeq: number, toSeq: number | null) => void
}) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const kind = kindMeta(v.kind)
  return (
    <li className="py-3 first:pt-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-md bg-black/[0.05] dark:bg-white/[0.07] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink">
          #{v.seq}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn('rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide', kind.cls)}>
              {KIND_WORD[v.kind] ?? kind.label}
            </span>
            <p className="min-w-0 text-[13px] font-medium text-ink break-words">
              {v.message || <span className="text-ink-muted font-normal">No message</span>}
            </p>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
            <span className="inline-flex items-center gap-1">
              {!v.author.id && <Bot className="w-3 h-3" aria-hidden />}
              {who(v.author, me)}
            </span>
            <span aria-hidden>·</span>
            <DateTime at={v.at} />
            <span aria-hidden>·</span>
            <Counts counts={v.counts} />
          </div>
          <div className="mt-1.5 -ml-2 flex flex-wrap items-center gap-1">
            <Expander open={open} onToggle={() => setOpen((o) => !o)} controls={panel} icon={ListTree}
              label={open ? 'Hide changes' : 'Changes'} />
            <button
              type="button"
              onClick={() => onCompare(v.seq - 1, v.seq)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
              <GitCompareArrows className="w-3.5 h-3.5" aria-hidden /> Compare
              <span className="sr-only">version #{v.seq} with the one before</span>
            </button>
          </div>
        </div>
      </div>
      {open && (
        <div id={panel} className="mt-2 ml-1">
          <ChangeList wsId={wsId} graphId={graphId} origin={{ fromSeq: v.seq - 1, toSeq: v.seq }}
            emptyHint="This version changed no entities." maxHeight="40vh" />
        </div>
      )}
    </li>
  )
}

function WatchedRow({ w, wsId, graphId, mainBranchId }: {
  w: DigestWatched
  wsId: string
  graphId: string
  mainBranchId: string | null
}) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const status = CHANGE_STATUS[w.change]
  return (
    <li className="rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.03] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={w.name || w.urn}>{w.name || w.urn}</span>
        <NodeDiffBadge status={status} withLabel className={COUNT_TONE[status]} />
        <span className="text-[11px] text-ink-muted">
          in #{w.seq} · <DateTime at={w.at} />
        </span>
        <span className="ml-auto">
          <Expander open={open} onToggle={() => setOpen((o) => !o)} controls={panel} icon={History}
            label={open ? 'Hide history' : 'History'} />
        </span>
      </div>
      {open && (
        <div id={panel} className="mt-2">
          <EntityHistory wsId={wsId} graphId={graphId} entityId={w.entityId} mainBranchId={mainBranchId}
            branchId={null} kind="node" />
        </div>
      )}
    </li>
  )
}

function Loading() {
  return (
    <div role="status" aria-busy="true" className="space-y-5">
      <span className="sr-only">Loading what changed</span>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[58px] rounded-xl" />)}
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-5 w-10" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
        </div>
      ))}
    </div>
  )
}

export function DigestSheet({ wsId, graphId, mainBranchId, open, onOpenChange, onCompare }: {
  wsId: string
  graphId: string
  mainBranchId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Two versions to compare in History; `toSeq` null is Published as it is now. */
  onCompare: (fromSeq: number, toSeq: number | null) => void
}) {
  const q = useGraphDigest(wsId, graphId)
  const mark = useMarkDigestSeen(wsId, graphId)
  const me = useAuthStore((s) => s.user?.id ?? null)
  const { notify } = useAppNotifications()
  const d = q.data

  const markSeen = () => {
    if (!d) return
    mark.mutate(d.head.seq, {
      onSuccess: () => notify('success', `Marked as seen up to version #${d.head.seq}.`),
      onError: (e) => notify('error', `Couldn't mark it seen: ${(e as Error).message}`),
    })
  }

  const fromSeq = d ? (d.since?.seq ?? Math.max(0, (d.versions.at(-1)?.seq ?? d.head.seq) - 1)) : 0
  const canMark = !!d && d.since?.seq !== d.head.seq

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={d ? 'What changed' : undefined}
      title={d ? (d.since ? 'Since your last visit' : 'The last 7 days') : 'What changed'}
      description={d ? (d.since ? (
        <>You marked it seen at version #{d.since.seq}, <DateTime at={d.since.at} className="text-ink" />.</>
      ) : (
        <>You haven’t marked this graph seen yet, so here is everything published in the last 7 days.</>
      )) : undefined}
      footer={d && (d.versions.length > 0 || canMark) ? (
        <>
          {d.versions.length > 0 && (
            <Button variant="secondary" size="md" leftIcon={GitCompareArrows} onClick={() => onCompare(fromSeq, null)}>
              Compare all
            </Button>
          )}
          {canMark && (
            <Button variant="primary" size="md" leftIcon={CheckCheck} loading={mark.isPending} onClick={markSeen}>
              Mark as seen
            </Button>
          )}
        </>
      ) : undefined}
    >
      {q.isLoading ? <Loading /> : q.isError || !d ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load what changed"
          description={(q.error as Error | null)?.message || 'Something went wrong reading this graph’s history.'}
          action={{ label: 'Try again', onClick: () => { void q.refetch() } }}
        />
      ) : (
        <div className="space-y-6">
          {/* With nothing published since, the figures would be zeros beside the message saying so. */}
          {d.versions.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Tile label={d.since ? 'New versions' : 'Versions'}
                value={d.total == null ? `${formatCount(d.versions.length)}+` : formatCount(d.total)}
                detail={d.since ? `Published after version #${d.since.seq}, up to #${d.head.seq}.`
                  : 'Published in the last 7 days.'} />
              <Tile label="Authors" value={formatCount(d.authors.length)}
                detail={d.truncated ? 'Who published the versions listed here.' : 'Who published these versions.'} />
              <Tile label="Reviews waiting" value={`${formatCount(d.reviewsWaiting.length)}${d.reviewsMore ? '+' : ''}`}
                detail="Reviews into this graph asking you to review, that you haven’t approved as they are now." />
              <Tile label="You watch" value={formatCount(d.watchedChanged.length)}
                detail="Entities you watch that these versions changed." />
            </div>
          )}

          {d.reviewsWaiting.length > 0 && (
            <Section icon={GitPullRequestArrow} title="Reviews waiting on you" count={d.reviewsMore ? `${d.reviewsWaiting.length}+` : d.reviewsWaiting.length}>
              <ul className="space-y-2">
                {d.reviewsWaiting.map((r) => (
                  <li key={r.id}>
                    <Link to={r.url} onClick={() => onOpenChange(false)}
                      className="group flex items-center gap-3 rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.03] px-3 py-2.5 hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                      <GitPullRequestArrow className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{r.title || 'Untitled review'}</span>
                        <span className="block text-[11px] text-ink-muted">
                          {who(r.author, me)} asked <DateTime at={r.at} />
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-lineage">
                        Open <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {d.watchedChanged.length > 0 && (
            <Section icon={Eye} title="Things you watch" count={d.watchedChanged.length}>
              <ul className="space-y-2">
                {d.watchedChanged.map((w) => (
                  <WatchedRow key={w.urn} w={w} wsId={wsId} graphId={graphId} mainBranchId={mainBranchId} />
                ))}
              </ul>
            </Section>
          )}

          {d.versions.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing new since you last looked"
              description={d.since
                ? `You’re up to date with version #${d.head.seq}.`
                : `Nothing was published in the last 7 days. The latest version is #${d.head.seq}.`}
            />
          ) : (
            <>
              <Section icon={Users} title="Who published"
                count={d.truncated ? `${d.authors.length} in the latest ${formatCount(d.versions.length)}` : d.authors.length}>
                <ul className="flex flex-wrap gap-2">
                  {d.authors.map((a) => (
                    <li key={a.id ?? 'platform'} className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-glass-border py-1 pl-1 pr-3">
                      {a.id ? (
                        <PersonChip id={a.id} person={{ name: a.id === me ? 'You' : a.name }} link={false} size="sm" />
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-black/[0.05] dark:bg-white/[0.07]">
                            <Bot className="h-3 w-3 text-ink-muted" aria-hidden />
                          </span>
                          The platform
                        </span>
                      )}
                      <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">{formatCount(a.versions, 'version')}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section icon={History} title="Versions" count={d.total == null ? `${d.versions.length}+` : d.total}>
                {d.truncated && (
                  <div className="flex gap-2.5 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] p-3 text-[12px]">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-700 dark:text-indigo-300" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {d.total != null
                          ? `Showing the latest ${formatCount(d.versions.length)} of ${formatCount(d.total)} versions`
                          : `Showing the latest ${formatCount(d.versions.length)} versions — there are more`}
                      </p>
                      <p className="mt-0.5 text-ink-muted">
                        {d.since
                          ? 'Compare all reaches every change since your last visit, however many there are.'
                          : `Compare all reaches every change from version #${d.versions.at(-1)?.seq ?? d.head.seq} to now.`}
                      </p>
                    </div>
                  </div>
                )}
                <ol className="divide-y divide-glass-border/70">
                  {d.versions.map((v) => (
                    <VersionRow key={v.seq} v={v} wsId={wsId} graphId={graphId} me={me} onCompare={onCompare} />
                  ))}
                </ol>
              </Section>
            </>
          )}
        </div>
      )}
    </Drawer>
  )
}
