/**
 * ChangesExplorer — every change a review lists, beside the canvas: a draft's, a revision's, or two
 * revisions compared (`useChangesScope`), at any size, a page at a time.
 *
 * - **The scope is its title:** a menu where the canvas offers more than one.
 * - **One row of controls:** the operation (all, or one of added, modified, deleted, with counts)
 *   and a search. Kind and type sit behind Filter.
 * - **The rows** are `ChangeRows`, the change list's own. Picking one makes it the review's current
 *   change, found on the canvas; its chevron shows what changed. The current change is marked, and
 *   kept in view as the navigator moves through the list (`useReviewList` gives both the same pages).
 *
 * It shares the Context View's left rail with search results: opening one closes the other, and
 * each keeps what it was showing (the review's in `reviewStore`). Closing it keeps the review going
 * on the navigator. It fetches nothing while no review is open.
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ListFilter, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import type { ChangeListKind, ChangeListStatus } from '@/services/versioningApiService'
import { useCanvasStore } from '@/store/canvas'
import { useReviewStore } from '@/store/reviewStore'
import type { ScopeOption } from '../hooks/useChangesScope'
import { useReviewList } from '../hooks/useReviewList'
import { KIND_LABEL, changeTotal, kindCounts, typeOptionsOf } from '../model/changeListSummary'
import { ChangeRows, TooLargeToList } from './ChangeList'
import { NodeDiffBadge, STATUS_META } from './NodeDiffBadge'

const RAIL_WIDTH = 376
const OPERATIONS: ChangeListStatus[] = ['added', 'modified', 'removed']
type OperationChoice = ChangeListStatus | 'all'

/** Room for the list, the canvas and a drawer side by side. */
const ROOM_FOR_THREE = '(min-width: 1280px)'
function useRoomForThree(): boolean {
  const [roomy, setRoomy] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia(ROOM_FOR_THREE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(ROOM_FOR_THREE)
    const sync = () => setRoomy(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return roomy
}

export function ChangesExplorer({ viewId }: { viewId: string | null }) {
  // Narrower than that, the list gives way while a drawer is open, and comes back after it: the
  // review goes on in the navigator.
  const drawerOpen = useCanvasStore((s) => !!s.drawerNodeId || !!s.drawerEdge)
  const roomy = useRoomForThree()
  const open = useReviewStore((s) => s.listOpen) && (roomy || !drawerOpen)
  const list = useReviewList(viewId)
  const { wsId, graphId, options, current } = list

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          data-panel="changes-explorer"
          aria-label="Review changes"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: RAIL_WIDTH, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          className="relative h-full flex-shrink-0 overflow-hidden bg-canvas-elevated/98 backdrop-blur-2xl border-r border-glass-border shadow-2xl shadow-black/25"
        >
          <div className="h-full flex flex-col overflow-hidden" style={{ width: RAIL_WIDTH }}>
            {wsId && graphId && current ? (
              <Explorer wsId={wsId} graphId={graphId} options={options} current={current} list={list} />
            ) : (
              <>
                <Header options={[]} current={null} />
                <p className="px-4 py-8 text-sm text-ink-muted text-center">Nothing has been published here yet.</p>
              </>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function Header({ options, current, children }: {
  options: ScopeOption[]
  current: ScopeOption | null
  children?: React.ReactNode
}) {
  const toggleList = useReviewStore((s) => s.toggleList)
  const setScope = useReviewStore((s) => s.setScope)
  return (
    <div className="px-4 pt-3 pb-3 border-b border-glass-border">
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/80">Review changes</span>
        <div className="flex-1" />
        <button type="button" onClick={toggleList} aria-label="Close the list"
          className="p-1 -mr-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {current && (options.length > 1 ? (
        <label className="relative mt-0.5 flex items-center w-fit max-w-full">
          <span className="sr-only">What to review</span>
          <select
            value={options.indexOf(current)}
            onChange={(e) => setScope(options[Number(e.target.value)].scope)}
            className="appearance-none bg-transparent pr-5 text-[15px] font-semibold text-ink truncate cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
          >
            {options.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
          </select>
          <ChevronDown className="w-3.5 h-3.5 absolute right-0 text-ink-muted pointer-events-none" />
        </label>
      ) : (
        <h2 className="mt-0.5 text-[15px] font-semibold text-ink truncate">{current.label}</h2>
      ))}
      {children}
    </div>
  )
}

function Explorer({ wsId, graphId, options, current, list }: {
  wsId: string
  graphId: string
  options: ScopeOption[]
  current: ScopeOption
  list: ReturnType<typeof useReviewList>
}) {
  const operation = useReviewStore((s) => s.operation)
  const filter = useReviewStore((s) => s.filter)
  const setOperation = useReviewStore((s) => s.setOperation)
  const setFilter = useReviewStore((s) => s.setFilter)
  const visiting = useReviewStore((s) => s.current?.entityId ?? null)
  const visit = useReviewStore((s) => s.visit)
  const { summaryQ, s, kinds, kind, rowsFilter } = list
  const counts = s && kind ? kindCounts(s, kind) : null
  const typeOptions = useMemo(() => typeOptionsOf(s, kind), [s, kind])
  const [filtersShown, setFiltersShown] = useState(false)
  const filtered = !!filter.type || (kinds.length > 1 && kind !== kinds[0])

  const operationOptions: SegmentedOption<OperationChoice>[] = [
    { value: 'all', label: 'All', count: counts ? counts.added + counts.modified + counts.removed : undefined },
    ...OPERATIONS.map((op) => ({
      value: op, label: STATUS_META[op].label, count: counts?.[op], disabled: !!counts && counts[op] === 0,
    })),
  ]
  const kindOptions: SegmentedOption<ChangeListKind>[] = kinds.map((k) => ({
    value: k, label: KIND_LABEL[k], count: s ? changeTotal(kindCounts(s, k)) : undefined,
  }))

  return (
    <>
      <Header options={options} current={current}>
        {s && s.total > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted tabular-nums">
            <span>{s.approximate ? 'About ' : ''}{s.total.toLocaleString()} {s.total === 1 ? 'change' : 'changes'}</span>
            {OPERATIONS.map((st) => s.counts[st] > 0 && <NodeDiffBadge key={st} status={st} count={s.counts[st]} />)}
          </div>
        )}
      </Header>

      {!s ? (
        summaryQ.isError
          ? <p className="px-4 py-6 text-xs text-ink-muted">Couldn't load these changes. Try again in a moment.</p>
          : <div className="px-4 py-4 space-y-2" aria-busy><Skeleton className="h-7 w-2/3" /><SkeletonText lines={4} /></div>
      ) : s.total === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted text-center">
          {'branchId' in current.origin ? 'Nothing is saved to this draft yet.' : 'Nothing changed here.'}
        </p>
      ) : s.listed === 0 && s.tooLarge ? (
        <TooLargeToList summary={s} className="m-4" />
      ) : (
        <>
          <div className="px-4 pt-3 pb-2 space-y-2">
            <Segmented label="Show" options={operationOptions} value={operation ?? 'all'}
              onChange={(v) => setOperation(v === 'all' ? null : v)} />
            <div className="flex items-center gap-2">
              <label className="relative flex-1 min-w-0">
                <span className="sr-only">Search these changes</span>
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted/70 pointer-events-none" />
                <input
                  value={filter.q ?? ''}
                  onChange={(e) => setFilter({ ...filter, q: e.target.value })}
                  placeholder="Search by name, urn or type…"
                  className="w-full h-8 pl-8 pr-2.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
                />
              </label>
              {(kinds.length > 1 || typeOptions.length > 1) && (
                <button
                  type="button"
                  aria-expanded={filtersShown}
                  // The kind listed, said where there is more than one: the counts beside are its.
                  aria-label={kinds.length > 1 && kind ? `Filter: ${KIND_LABEL[kind]}` : 'Filter'}
                  onClick={() => setFiltersShown((v) => !v)}
                  className={cn(
                    'relative inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border text-[12px] font-medium transition-colors',
                    filtersShown || filtered
                      ? 'border-accent-lineage/40 bg-accent-lineage/[0.08] text-ink'
                      : 'border-glass-border text-ink-muted hover:text-ink',
                  )}
                >
                  <ListFilter className="w-3.5 h-3.5" /> {kinds.length > 1 && kind ? KIND_LABEL[kind] : 'Filter'}
                  {filtered && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
                </button>
              )}
            </div>
            {filtersShown && (
              <div className="flex flex-wrap items-center gap-2">
                {kindOptions.length > 1 && kind && (
                  <Segmented label="What changed" options={kindOptions} value={kind}
                    onChange={(k) => setFilter({ ...filter, kind: k, type: undefined })} />
                )}
                {typeOptions.length > 1 && (
                  <select
                    aria-label="Type"
                    value={filter.type ?? ''}
                    onChange={(e) => setFilter({ ...filter, type: e.target.value || undefined })}
                    className="h-7 max-w-full rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border px-2 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
                  >
                    <option value="">All types</option>
                    {typeOptions.map((t) => (
                      <option key={t.type} value={t.type}>{t.type || 'Untyped'} · {t.n.toLocaleString()}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 flex flex-col gap-2 px-3 pb-3">
            <ChangeRows wsId={wsId} graphId={graphId} origin={current.origin} summary={s} kind={kind}
              statuses={rowsFilter.statuses ?? []} type={rowsFilter.type} q={rowsFilter.q ?? ''} fill
              activeEntityId={visiting} onActivate={visit} />
          </div>
        </>
      )}
    </>
  )
}
