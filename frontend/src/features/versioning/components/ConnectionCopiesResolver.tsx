/**
 * ConnectionCopiesResolver — say, connection by connection, how the copies of a connection the
 * source holds more than once are copied into version history.
 *
 * Version history keeps one connection per source, type and target; the enable job held every
 * connection whose copies say different things (`bootstrap_review`). Each one is shown with its
 * versions side by side — a row per property, the ones they disagree on marked — and the result it
 * will be copied as (`resolveCopies`, the job's own rule), so nobody continues blind:
 *
 *  • follow the review's rule (keep the first copy, or merge them), or override it here;
 *  • keep one version, or merge — leaving versions out, picking the value where they disagree;
 *  • leave properties out.
 *
 * Every change is saved as it is made (it is the job's to apply once the review is decided), so a
 * reload or another manager sees the same choices. Searchable, paged from the server and
 * virtualized (only the cards on screen are rendered; the next page loads as the list nears its
 * end), so a graph holding thousands of them stays quick. The modal follows ConflictResolver's
 * shell (portal, stop mousedown at the root).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRight, Check, Download, GitMerge, Loader2, Search, ShieldCheck, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import {
  CONFIDENCE_PICK, bootstrapReviewCsvUrl, type BootstrapReviewChoice, type BootstrapReviewConnection,
} from '@/services/versioningApiService'
import { useBootstrapReview, useSaveBootstrapReviewChoice } from '../hooks/useVersioning'
import { effectiveRule, propertyNames, resolveCopies, type ReviewPolicy } from '../model/reviewResolution'

function fmt(v: unknown): { text: string; muted: boolean } {
  if (v === undefined) return { text: '—', muted: true }
  if (v === null) return { text: 'null', muted: true }
  if (typeof v === 'string') return v ? { text: v, muted: false } : { text: '(empty)', muted: true }
  if (typeof v === 'object') return { text: JSON.stringify(v), muted: false }
  return { text: String(v), muted: false }
}

function Value({ value }: { value: unknown }) {
  const { text, muted } = fmt(value)
  return <span className={cn('break-all line-clamp-3', muted ? 'italic text-ink-muted/60' : 'text-ink')}>{text}</span>
}

const RULE_LABEL: Record<ReviewPolicy['rule'], string> = {
  keep_first: 'keep the first copy',
  merge: 'merge the copies',
}

export function ConnectionCopiesResolver({
  wsId, dataSourceId, policy, onClose,
}: {
  wsId: string
  dataSourceId: string
  /** The review's rule for every connection without a choice of its own (null: not chosen yet). */
  policy: ReviewPolicy | null
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const review = useBootstrapReview(wsId, dataSourceId, 'copies', query)
  const save = useSaveBootstrapReviewChoice(wsId, dataSourceId)
  const items = (review.data?.pages ?? []).flatMap((p) => p.items as BootstrapReviewConnection[])
  // Which connection a save is for, and whether the last one landed: each card says so itself.
  const [saved, setSaved] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({})
  const choose = (entityId: string, choice: BootstrapReviewChoice | null) => {
    setSaved((m) => ({ ...m, [entityId]: 'saving' }))
    save.mutate({ entityId, choice }, {
      onSuccess: () => setSaved((m) => ({ ...m, [entityId]: 'saved' })),
      onError: () => setSaved((m) => ({ ...m, [entityId]: 'failed' })),
    })
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer's functions are read at render, by design
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 260,
    overscan: 4,
    getItemKey: (i) => items[i].entityId,
  })
  const visible = rows.getVirtualItems()
  const last = visible.length ? visible[visible.length - 1].index : -1
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = review
  // The next page as the list nears its end: nobody pages through thousands by hand.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && last >= items.length - 3) fetchNextPage()
  }, [last, items.length, hasNextPage, isFetchingNextPage, fetchNextPage])
  const ownChoices = items.filter((i) => i.choice).length

  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[70]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connections held more than once"
        className="fixed inset-0 z-[70] flex items-center justify-center p-4"
        onClick={onClose}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="w-full max-w-[1180px] max-h-[90vh] flex flex-col rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-glass-border/60">
            <div className="flex items-start gap-3">
              <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-500/[0.04] ring-1 ring-amber-500/20 shrink-0">
                <GitMerge className="w-5 h-5 text-amber-500" />
              </span>
              <div>
                <h3 className="text-[15px] font-semibold text-ink">Connections held more than once</h3>
                <p className="text-[12px] text-ink-muted mt-1 leading-relaxed">
                  Each of these connections is in the source more than once, and its copies say different
                  things. Version history keeps one connection per source, type and target, so say how each is
                  copied — or leave it to the rule you chose
                  {policy ? <> (<span className="font-medium text-ink">{RULE_LABEL[policy.rule]}</span>)</> : ' for all of them'}.
                </p>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-start gap-2 px-6 py-2.5 bg-emerald-500/[0.06] border-b border-emerald-500/15 text-[11.5px] leading-relaxed text-ink-muted">
            <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-px" />
            <span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">Nothing is lost while you decide.</span>{' '}
              The source graph is not changed, nothing goes live until you continue, and every version stays
              listed afterwards as the record of what was decided.
            </span>
          </div>

          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-glass-border/60 bg-canvas-elevated/30">
            <a
              href={bootstrapReviewCsvUrl(wsId, dataSourceId, 'copies')}
              download={`connections-held-more-than-once-${dataSourceId}.csv`}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-lineage hover:underline"
            >
              <Download className="w-3 h-3" /> Every version (CSV)
            </a>
            <div className="relative ml-auto">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60 pointer-events-none" />
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a connection or value…"
                aria-label="Find a connection"
                className="w-56 pl-7 pr-2 py-1 rounded-md bg-canvas border border-glass-border text-[11px] text-ink placeholder:text-ink-muted/50 focus:outline-none focus:border-accent-lineage/40"
              />
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
            {review.isLoading ? (
              <p className="text-xs text-ink-muted text-center py-8 inline-flex items-center gap-1.5 w-full justify-center" role="status">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Reading the connections…
              </p>
            ) : items.length === 0 ? (
              <p className="text-xs text-ink-muted text-center py-8">
                {query ? <>No connection matches “{query}”.</> : 'No connection is held.'}
              </p>
            ) : (
              <div style={{ height: rows.getTotalSize(), position: 'relative', width: '100%' }}>
                {visible.map((vi) => {
                  const item = items[vi.index]
                  return (
                    <div
                      key={vi.key} data-index={vi.index} ref={rows.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      className="pb-3"
                    >
                      <ConnectionCard
                        item={item} policy={policy} state={saved[item.entityId]}
                        onChoose={(choice) => choose(item.entityId, choice)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            {isFetchingNextPage && (
              <p className="text-[11px] text-ink-muted text-center py-2 inline-flex items-center gap-1.5 w-full justify-center" role="status">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Reading more connections…
              </p>
            )}
          </div>

          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-between gap-3">
            <span className="text-[11px] text-ink-muted">
              {save.isError
                ? <span className="text-rose-500">{save.error instanceof Error ? save.error.message : 'Could not save that choice.'}</span>
                : <>
                    {items.length > 0 && <>{ownChoices.toLocaleString()} of {items.length.toLocaleString()}{hasNextPage ? '+' : ''} shown
                      have a choice of their own · </>}
                    Choices are saved as you make them.
                  </>}
            </span>
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

// ── one connection, its versions side by side ────────────────────────────────────────────────────
function ConnectionCard({
  item, policy, state, onChoose,
}: {
  item: BootstrapReviewConnection
  policy: ReviewPolicy | null
  /** Its last save: under way, done, or refused. */
  state?: 'saving' | 'saved' | 'failed'
  onChoose: (choice: BootstrapReviewChoice | null) => void
}) {
  const saving = state === 'saving'
  const own = item.choice
  const rule = effectiveRule(own, policy)
  const result = resolveCopies(item.versions, own, policy)
  const names = propertyNames(item.versions)
  const clashing = new Set(item.clashing)
  const leftOutCopies = new Set(own?.excludeCopies ?? [])
  const leftOutProps = new Set([...(policy?.excludeProperties ?? []), ...(own?.excludeProperties ?? [])])
  const merging = rule === 'merge'
  // A change starts from what the connection is copied as now, so it changes only what it says.
  const base = (): BootstrapReviewChoice => own ?? { rule: rule === 'keep' ? 'keep_first' : rule }
  const change = (next: Partial<BootstrapReviewChoice>) => onChoose({ ...base(), ...next })
  const pick = (name: string, seq: number) => change({ rule: 'merge', values: { ...(own?.values ?? {}), [name]: seq } })
  const picked = (name: string) => (own?.values ?? {})[name]
  const copies = item.versions.reduce((n, v) => n + v.count, 0)

  return (
    <section className="rounded-xl border border-glass-border bg-canvas-elevated/30" aria-label={`Connection ${item.entityId}`}>
      <header className="flex items-center gap-2 px-3.5 py-2.5 border-b border-glass-border/60 flex-wrap">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-secondary" title={item.source ?? ''}>{item.source}</span>
        <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted">{item.edgeType}</span>
        <ArrowRight className="w-3 h-3 text-ink-muted shrink-0" />
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-secondary" title={item.target ?? ''}>{item.target}</span>
        <span className="ml-auto inline-flex items-center gap-2 text-[11px] text-ink-muted">
          {state === 'saving' && <span className="inline-flex items-center gap-1" role="status"><Loader2 className="w-3 h-3 animate-spin" aria-hidden /> Saving</span>}
          {state === 'saved' && <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" role="status"><Check className="w-3 h-3" aria-hidden /> Saved</span>}
          {state === 'failed' && <span className="text-rose-500" role="status">Not saved</span>}
          <span>{copies} copies, {item.versions.length} versions</span>
        </span>
      </header>

      <div className="flex items-center gap-1.5 px-3.5 pt-2.5 flex-wrap" role="radiogroup" aria-label="How this connection is copied">
        <RuleButton active={!own} onClick={() => onChoose(null)} disabled={saving}>
          The rule for all{policy ? ` (${RULE_LABEL[policy.rule]})` : ''}
        </RuleButton>
        {item.versions.map((v) => (
          <RuleButton
            key={v.seq} active={!!own && rule === 'keep' && own.keep === v.seq} disabled={saving}
            onClick={() => onChoose({ rule: 'keep', keep: v.seq, excludeProperties: own?.excludeProperties ?? [] })}
          >
            Keep version {v.seq}
          </RuleButton>
        ))}
        <RuleButton
          active={!!own && rule === 'merge'} disabled={saving}
          onClick={() => onChoose({ rule: 'merge', excludeCopies: own?.excludeCopies ?? [], values: own?.values ?? {},
            excludeProperties: own?.excludeProperties ?? [] })}
        >
          Merge them
        </RuleButton>
      </div>

      <div className="px-3.5 py-2.5 overflow-x-auto">
        <table className="w-full text-[11px] border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1 pr-3 font-medium">Property</th>
              {item.versions.map((v) => (
                <th key={v.seq} className="py-1 pr-3 font-medium whitespace-nowrap">
                  Version {v.seq}
                  <span className="font-normal"> · {v.count === 1 ? '1 copy' : `${v.count} copies`}</span>
                  {merging && (
                    <label className="ml-2 inline-flex items-center gap-1 font-normal">
                      <input
                        type="checkbox" checked={!leftOutCopies.has(v.seq)} disabled={saving}
                        aria-label={`Include version ${v.seq} in the merge`}
                        onChange={(e) => {
                          const next = new Set(leftOutCopies)
                          if (e.target.checked) next.delete(v.seq); else next.add(v.seq)
                          if (next.size < item.versions.length) change({ rule: 'merge', excludeCopies: [...next].sort() })
                        }}
                      />
                      in merge
                    </label>
                  )}
                </th>
              ))}
              <th className="py-1 pr-3 font-medium text-emerald-600 dark:text-emerald-400">Copied as</th>
              <th className="py-1 font-medium">Leave out</th>
            </tr>
          </thead>
          <tbody>
            {[...names, CONFIDENCE_PICK].map((name) => {
              const isConf = name === CONFIDENCE_PICK
              const clash = clashing.has(name)
              const out = !isConf && leftOutProps.has(name)
              const valueOf = (seq: number) => {
                const v = item.versions.find((x) => x.seq === seq)!
                return isConf ? (v.confidence ?? undefined) : v.properties[name]
              }
              if (isConf && item.versions.every((v) => v.confidence == null)) return null
              return (
                <tr key={name} className={cn(clash && 'bg-amber-500/[0.05]', out && 'opacity-50')}>
                  <td className="py-1 pr-3 align-top font-mono text-ink-secondary whitespace-nowrap">
                    {isConf ? 'confidence' : name}
                    {clash && <span className="ml-1 text-[9px] font-semibold uppercase text-amber-600 dark:text-amber-400">differs</span>}
                  </td>
                  {item.versions.map((v) => {
                    const holds = isConf ? v.confidence != null : name in v.properties
                    const chosen = merging && clash && holds && !leftOutCopies.has(v.seq)
                    return (
                      <td key={v.seq} className="py-1 pr-3 align-top">
                        <label className={cn('inline-flex items-start gap-1.5', chosen && 'cursor-pointer')}>
                          {chosen && (
                            <input
                              type="radio" name={`${item.entityId}:${name}`} disabled={saving}
                              aria-label={`Use version ${v.seq}'s ${isConf ? 'confidence' : name}`}
                              checked={(picked(name) ?? result.from[name]) === v.seq}
                              onChange={() => pick(name, v.seq)}
                            />
                          )}
                          <Value value={valueOf(v.seq)} />
                        </label>
                      </td>
                    )
                  })}
                  <td className="py-1 pr-3 align-top font-medium">
                    {out ? <span className="italic text-ink-muted">left out</span>
                      : <Value value={isConf ? (result.confidence ?? undefined) : result.properties[name]} />}
                  </td>
                  <td className="py-1 align-top">
                    {!isConf && (
                      <input
                        type="checkbox" checked={out} disabled={saving || (policy?.excludeProperties ?? []).includes(name)}
                        aria-label={`Leave ${name} out`}
                        onChange={(e) => {
                          const mine = new Set(own?.excludeProperties ?? [])
                          if (e.target.checked) mine.add(name); else mine.delete(name)
                          change({ excludeProperties: [...mine].sort() })
                        }}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RuleButton({ active, children, ...rest }: { active: boolean; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button" role="radio" aria-checked={active}
      className={cn(
        'px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-60',
        active ? 'border-accent-lineage/40 bg-accent-lineage/[0.08] text-accent-lineage' : 'border-glass-border text-ink-muted hover:text-ink',
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
