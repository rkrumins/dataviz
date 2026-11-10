/**
 * RevisionCompare — what changed between two revisions of Published, or since one of them.
 *
 * Two ends, the older first (Now by default for the second): how much changed (added, modified,
 * removed), over how many revisions and by whom, which types it touched most, and the changes
 * themselves, a page at a time (`ChangeList` over the window). All of it comes from one classified
 * change index for the window, kept by the server for its pages, so the counts, the breakdown and
 * the list always agree — and none of it reads a payload until a row is opened.
 *
 * From here the comparison goes on to the canvas: highlighted on the newer revision, or either end
 * opened as the graph was then. On the Context View, **Review changes** highlights it and lists the
 * changes beside the canvas (`ChangesExplorer`), in place of the list here.
 */
import { useMemo } from 'react'
import { ArrowLeft, ArrowRight, Download, Eye, GitCompareArrows, Info, ListChecks, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import { UserAvatar } from '@/components/ui/UserAvatar'
import type { ChangeListSummary, ChangeListTypeCount } from '@/services/versioningApiService'
import { useReviewStore } from '@/store/reviewStore'
import { useChangeSummary } from '../hooks/useVersioning'
import { ownerName } from '../model/branchVocab'
import { ChangeList } from './ChangeList'
import { RevisionPicker } from './RevisionPicker'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat()
/** Types listed by name before the rest are folded into one row. */
const TYPES_SHOWN = 7

/** The change kinds, in their fixed order, as every change surface in the app colours them. Validated
 *  as a set (light: the 500 steps; dark: the 600s) for colour-blind separation; the 2px gaps between
 *  segments and the figures beside every bar are the second channel. */
const KINDS = [
  { key: 'added', label: 'Added', mark: 'bg-emerald-500 dark:bg-emerald-600' },
  { key: 'modified', label: 'Modified', mark: 'bg-amber-500 dark:bg-amber-600' },
  { key: 'removed', label: 'Deleted', mark: 'bg-rose-500 dark:bg-rose-600' },
] as const

export function RevisionCompare({
  wsId, graphId, from, to, headSeq, notice = null, canOpen, openBlocked = null,
  onChange, onBack, onOpen, onHighlight, onExport,
}: {
  wsId: string
  graphId: string
  from: number
  /** null: Published as it is now. */
  to: number | null
  headSeq: number | null
  /** Shown instead of opening `from` on the canvas, which can't draw it. */
  notice?: 'too_far' | 'fork' | null
  /** The canvas can open revisions (the revision viewer). */
  canOpen: boolean
  /** Why neither end can be opened or highlighted from here (nowhere to open them), or null. */
  openBlocked?: string | null
  onChange: (from: number, to: number | null) => void
  onBack: () => void
  /** Open a revision on the canvas; null is Published as it is now. */
  onOpen: (seq: number | null) => void
  onHighlight: (fromSeq: number, toSeq: number) => void
  onExport?: (seq: number) => void
}) {
  const newer = to ?? headSeq
  const range = useMemo(
    () => (newer != null && from < newer ? { fromSeq: from, toSeq: newer } : null), [from, newer])
  const summaryQ = useChangeSummary(wsId, graphId, range)
  const summary = summaryQ.data
  const sameEnds = newer != null && from >= newer
  // On the Context View the changes are reviewed beside the canvas, highlighted on it, rather than
  // listed here.
  const reviewable = useReviewStore((s) => s.available) && canOpen && !openBlocked
  const startReview = useReviewStore((s) => s.startReview)

  // Two ends in order: the older first, whichever was picked.
  const pick = (a: number | null, b: number | null) => {
    const av = a ?? headSeq ?? Number.MAX_SAFE_INTEGER
    const bv = b ?? headSeq ?? Number.MAX_SAFE_INTEGER
    if (a != null && b != null && av > bv) onChange(b, a)
    else if (a == null && b != null) onChange(b, null)
    else if (a != null) onChange(a, b)
  }

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-muted hover:text-ink">
        <ArrowLeft className="w-3.5 h-3.5" /> History
      </button>

      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink tracking-tight">
          <GitCompareArrows className="w-4 h-4 text-indigo-500" /> Compare revisions
        </h3>
        <p className="text-[12px] text-ink-muted mt-0.5">Everything that changed after the first, up to and including the second.</p>
      </div>

      {notice && (
        <div className="flex gap-3 rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] p-3">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
          <div className="min-w-0 text-[12px] leading-snug">
            <p className="font-semibold text-ink">
              {notice === 'fork' ? "A fork's past revisions can't be opened on the canvas yet"
                : `Revision #${from} is too far back to draw on the canvas`}
            </p>
            <p className="text-ink-muted mt-0.5">
              {notice === 'fork' ? "Here's everything that changed since — the list reaches all of it."
                : "So much has changed since that drawing it would mean rebuilding the graph. Here's everything that changed instead — and you can export the graph as it was then."}
            </p>
            {notice === 'too_far' && onExport && (
              <button
                onClick={() => onExport(from)}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20"
              >
                <Download className="w-3.5 h-3.5" /> Export as it was then
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
        <RevisionPicker wsId={wsId} graphId={graphId} label="From" value={from} headSeq={headSeq}
          onChange={(seq) => pick(seq, to)} />
        <ArrowRight className="w-4 h-4 self-center text-ink-muted/60" aria-hidden />
        <RevisionPicker wsId={wsId} graphId={graphId} label="To" value={to} headSeq={headSeq} allowNow
          onChange={(seq) => pick(from, seq)} />
      </div>

      {sameEnds ? (
        <p className="rounded-xl border border-glass-border px-4 py-6 text-center text-[13px] text-ink-muted">
          Pick two different revisions to see what changed between them.
        </p>
      ) : (
        <>
          <KpiRow summary={summary} loading={summaryQ.isLoading} />
          <TypeBreakdown summary={summary} loading={summaryQ.isLoading} />

          <div className="flex flex-wrap items-center gap-1.5">
            {reviewable && range && (
              <HoverTip className="inline-flex" label="Review changes"
                detail={`Highlights them on ${to == null ? 'Published as it is now' : `revision #${range.toSeq}`}, and lists them beside it.`}>
                <button
                  onClick={() => { onHighlight(range.fromSeq, range.toSeq); startReview() }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 active:scale-[0.98]"
                >
                  <ListChecks className="w-3.5 h-3.5" /> Review changes
                </button>
              </HoverTip>
            )}
            {canOpen && range && !reviewable && (
              <HoverTip className="inline-flex" label="Highlight on canvas"
                detail={openBlocked ?? `Opens ${to == null ? 'Published as it is now' : `revision #${range.toSeq}`} with these changes ringed.`}>
                <button
                  disabled={!!openBlocked}
                  onClick={() => onHighlight(range.fromSeq, range.toSeq)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 active:scale-[0.98] disabled:opacity-40"
                >
                  <Sparkles className="w-3.5 h-3.5" /> Highlight on canvas
                </button>
              </HoverTip>
            )}
            {canOpen && !notice && (
              <button disabled={!!openBlocked} onClick={() => onOpen(from)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-40 disabled:cursor-default">
                <Eye className="w-3.5 h-3.5" /> Open #{from}
              </button>
            )}
            {canOpen && to != null && (
              <button disabled={!!openBlocked} onClick={() => onOpen(to)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-40 disabled:cursor-default">
                <Eye className="w-3.5 h-3.5" /> Open #{to}
              </button>
            )}
            {canOpen && openBlocked && <span className="text-[11px] text-ink-muted">{openBlocked}</span>}
          </div>

          {range && !reviewable && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2 px-0.5">The changes</p>
              <ChangeList
                wsId={wsId}
                graphId={graphId}
                origin={range}
                summary={summary}
                emptyHint="Nothing changed between these revisions."
                maxHeight="46vh"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Added · Modified · Deleted · Revisions · Contributors — the comparison at a glance. */
function KpiRow({ summary, loading }: { summary?: ChangeListSummary; loading: boolean }) {
  const counts = summary?.counts
  const approx = !!summary?.approximate
  const w = summary?.window
  const names = summary?.userNames
  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
      {KINDS.map((k) => (
        <Tile key={k.key} label={k.label} swatch={k.mark} loading={loading}
          value={counts ? counts[k.key] : null} approx={approx} />
      ))}
      <Tile label="Revisions" loading={loading} value={w?.commitCount ?? null} />
      <div className="rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-3 py-2 min-w-0">
        <p className="text-[11px] text-ink-muted">Contributors</p>
        {loading ? <Skeleton className="mt-1.5 h-5 w-14" /> : (
          <div className="mt-1 flex items-center gap-1.5 min-w-0">
            <span className="text-lg font-semibold text-ink leading-tight">{w?.contributorCount ?? 0}</span>
            {w && w.contributors.length > 0 && (
              <HoverTip className="inline-flex min-w-0" label="Who made these changes"
                detail={w.contributors.map((c) => ownerName(c, names)).join(', ')}>
                <span className="inline-flex items-center -space-x-1.5">
                  {w.contributors.slice(0, 3).map((c) => (
                    <UserAvatar key={c} userId={c} name={ownerName(c, names)} shape="gradient"
                      className="w-5 h-5 text-[8px] font-bold ring-2 ring-canvas" />
                  ))}
                </span>
              </HoverTip>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, loading, swatch, approx = false }: {
  label: string
  value: number | null
  loading: boolean
  swatch?: string
  approx?: boolean
}) {
  return (
    <div className="rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-3 py-2 min-w-0">
      <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        {swatch && <span aria-hidden className={cn('w-2 h-2 rounded-sm', swatch)} />}
        {label}
      </p>
      {loading ? <Skeleton className="mt-1.5 h-5 w-12" /> : (
        <HoverTip className="inline-flex" label={value == null ? '—' : `${approx ? 'About ' : ''}${whole.format(value)}`}>
          <p className="mt-0.5 text-lg font-semibold text-ink leading-tight">
            {value == null ? '—' : `${approx ? '≈' : ''}${compact.format(value)}`}
          </p>
        </HoverTip>
      )}
    </div>
  )
}

type TypeTotal = ChangeListTypeCount & { total: number; other?: boolean }

/** The types the comparison touched most, each a thin bar split into what was added, modified and
 *  removed — its length the type's share of the largest — with the figures beside it. */
function TypeBreakdown({ summary, loading }: { summary?: ChangeListSummary; loading: boolean }) {
  const rows = useMemo<TypeTotal[]>(() => {
    const all: TypeTotal[] = (summary?.byType ?? []).map((t) => ({ ...t, total: t.added + t.modified + t.removed }))
      .filter((t) => t.total > 0).sort((a, b) => b.total - a.total)
    if (all.length <= TYPES_SHOWN + 1) return all
    const rest = all.slice(TYPES_SHOWN)
    const other = rest.reduce<TypeTotal>((acc, t) => ({
      ...acc, added: acc.added + t.added, modified: acc.modified + t.modified,
      removed: acc.removed + t.removed, total: acc.total + t.total,
    }), { kind: 'node', type: `${rest.length} other types`, added: 0, modified: 0, removed: 0, total: 0, other: true })
    return [...all.slice(0, TYPES_SHOWN), other]
  }, [summary])
  const max = Math.max(1, ...rows.map((r) => r.total))

  if (loading) {
    return (
      <div className="space-y-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3"><Skeleton className="h-3 w-24" /><Skeleton className="h-2 flex-1" /></div>
        ))}
      </div>
    )
  }
  if (!summary) return null
  if (rows.length === 0) {
    return summary.tooLarge ? (
      <p className="text-[12px] text-ink-muted">Too many changes to break down by type — the counts above come from what each revision recorded.</p>
    ) : null
  }
  return (
    <section aria-label="Changed by type">
      <div className="flex items-center justify-between mb-2 px-0.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/70">Changed by type</p>
        <span className="flex items-center gap-3 text-[11px] text-ink-muted" aria-hidden>
          {KINDS.map((k) => (
            <span key={k.key} className="inline-flex items-center gap-1"><span className={cn('w-2.5 h-2 rounded-sm', k.mark)} />{k.label}</span>
          ))}
        </span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <TypeRow key={`${r.kind}:${r.type ?? ''}`} row={r} max={max} />
        ))}
      </ul>
    </section>
  )
}

function TypeRow({ row, max }: { row: TypeTotal; max: number }) {
  const name = row.type || (row.kind === 'edge' ? 'Relationship' : 'Entity')
  const label = `${name}: ${whole.format(row.added)} added, ${whole.format(row.modified)} modified, ${whole.format(row.removed)} removed`
  return (
    <li className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3" aria-label={label}>
      <span className="flex items-center gap-1.5 min-w-0 text-[12px] text-ink">
        <span className="truncate">{name}</span>
        {row.kind === 'edge' && !row.other && <span className="shrink-0 text-[9px] uppercase tracking-wide text-ink-muted/70">rel</span>}
        {row.kind === 'structure' && <span className="shrink-0 text-[9px] uppercase tracking-wide text-ink-muted/70">link</span>}
      </span>
      {/* Square at the baseline, its data end rounded; a 2px gap of surface between segments. */}
      <span className="flex h-2 min-w-0 gap-[2px]" style={{ width: `${Math.max(2, (100 * row.total) / max)}%` }}>
        {(() => {
          const present = KINDS.filter((k) => row[k.key] > 0)
          return present.map((k, i) => (
            <span key={k.key} className="flex h-full min-w-[3px]" style={{ width: `${(100 * row[k.key]) / row.total}%` }}>
              <HoverTip className="flex h-full w-full" width="control" label={`${whole.format(row[k.key])} ${k.label.toLowerCase()}`}>
                <span className={cn('block h-full w-full hover:brightness-110', k.mark,
                  i === present.length - 1 && 'rounded-r-[4px]')} />
              </HoverTip>
            </span>
          ))
        })()}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-ink tabular-nums">
        {KINDS.map((k) => row[k.key] > 0 && (
          <span key={k.key} className="inline-flex items-center gap-1">
            <span aria-hidden className={cn('w-1.5 h-1.5 rounded-full', k.mark)} />{compact.format(row[k.key])}
          </span>
        ))}
      </span>
    </li>
  )
}
