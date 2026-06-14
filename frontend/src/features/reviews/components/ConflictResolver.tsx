/**
 * ConflictResolver — resolve a PR's field-level merge conflicts, then re-merge.
 *
 * The backend reports conflicts as `{entity_id, path, base, ours, theirs}` (a field slice),
 * but the merge API takes resolutions as a map of **whole-entity payloads**
 * (`{entityId: payload | null}`). So per conflicted entity we seed the working payload from
 * the merged result (the diff's `after`, which already has every non-conflicting field) and
 * overlay the user's per-field pick via an immutable `setIn`. Picking "Delete" resolves the
 * entity to `null`.
 *
 * Built to scale to hundreds/thousands of conflicting entities:
 *   • the entity list is virtualized (`@tanstack/react-virtual`) so only on-screen cards mount;
 *   • bulk "take all" actions set every field to one side at once (then tweak the exceptions);
 *   • a search box filters to the entity you need.
 *
 * Close-on-click fix: this modal renders through a portal to `document.body`, but call sites
 * like BranchSwitcher use a NATIVE `document` "mousedown → close if outside my ref" listener.
 * Because the portal is outside that ref, every interaction read as "outside" and tore the
 * modal down before a click could even register (mousedown precedes click). We stop `mousedown`/
 * `pointerdown` at the modal root so they never reach those document-level listeners. We do NOT
 * touch `click`, so React's own button handlers still fire.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Loader2, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ResolutionMap } from '@/services/versioningApiService'
import {
  type Side, normalizeConflict, conflictKey as ckey, groupByEntity, buildResolutions,
} from '../conflictResolution'

const SIDE_LABEL: Record<Side, string> = { theirs: 'Current target', ours: 'This PR', base: 'Original' }
const SIDES: Side[] = ['theirs', 'ours', 'base']

function ValuePreview({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="italic text-ink-muted/60">— none —</span>
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return <span className="font-mono break-all line-clamp-3">{text}</span>
}

export function ConflictResolver({
  conflicts,
  seeds,
  busy,
  error,
  onCancel,
  onResolve,
}: {
  conflicts: Array<Record<string, unknown>>
  /** entityId → the merged payload (diff `after`) used to seed each resolution. */
  seeds: Record<string, Record<string, unknown> | undefined>
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onResolve: (resolutions: ResolutionMap) => void
}) {
  const normalized = useMemo(() => conflicts.map((c) => normalizeConflict(c)).filter((c) => c.entity_id), [conflicts])
  const byEntity = useMemo(() => groupByEntity(normalized), [normalized])
  const allEntries = useMemo(() => [...byEntity.entries()], [byEntity])

  // Per-field pick (default: take this PR's change) + per-entity delete toggle.
  const [picks, setPicks] = useState<Record<string, Side>>({})
  const [deleted, setDeleted] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')

  // Seed/extend picks whenever the conflict set changes (initial open, or a retry that returned a
  // smaller-but-different set) without discarding picks the user already made for surviving fields.
  useEffect(() => {
    setPicks((prev) => {
      const next: Record<string, Side> = {}
      for (const c of normalized) {
        const k = ckey(c)
        next[k] = prev[k] ?? 'ours'
      }
      return next
    })
  }, [normalized])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? allEntries.filter(([eid]) => eid.toLowerCase().includes(q)) : allEntries
  }, [allEntries, query])

  // Bulk: set EVERY field (across all entities, not just the filtered view) to one side, and clear
  // delete marks — the "accept all theirs / all ours" path for a large conflict set.
  const takeAll = (side: Side) => {
    setPicks(Object.fromEntries(normalized.map((c) => [ckey(c), side])))
    setDeleted({})
  }

  const deletedCount = useMemo(() => Object.values(deleted).filter(Boolean).length, [deleted])
  const build = (): ResolutionMap => buildResolutions(byEntity, picks, deleted, seeds)

  // Virtualize the entity list so 1000s of conflicts don't mount 1000s of cards.
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 128,
    overscan: 8,
    getItemKey: (i) => filtered[i][0],
  })

  // Stop pointer-down events at the modal root so document-level "click outside → close"
  // listeners (BranchSwitcher) can't tear the portal down mid-interaction. Native + bubble phase
  // so it fires after the modal's own React handlers and before the event reaches `document`.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    el.addEventListener('mousedown', stop)
    el.addEventListener('pointerdown', stop)
    return () => {
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('pointerdown', stop)
    }
  }, [])

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={rootRef}
        key="conflict-resolver"
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onCancel}
      >
        <motion.div
          className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
          initial={{ scale: 0.96, y: 8 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.96, y: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-glass-border/60">
            <div className="flex items-start gap-2.5">
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 shrink-0">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-ink">Resolve {byEntity.size} conflicting {byEntity.size === 1 ? 'entity' : 'entities'}</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">The target moved under this PR. Pick a value for each field, then merge.</p>
              </div>
            </div>
            <button onClick={onCancel} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Toolbar: bulk "take all" + search — the scale controls. */}
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-glass-border/60 bg-canvas-elevated/30">
            <span className="text-[10px] uppercase tracking-wider text-ink-muted/70 font-semibold shrink-0">Take all</span>
            {SIDES.map((side) => (
              <button
                key={side}
                onClick={() => takeAll(side)}
                className="text-[11px] font-medium px-2 py-1 rounded-md border border-glass-border text-ink-muted hover:text-accent-lineage hover:border-accent-lineage/40 transition-colors"
              >
                {SIDE_LABEL[side]}
              </button>
            ))}
            <div className="relative ml-auto">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60 pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter entities…"
                className="w-48 pl-7 pr-2 py-1 rounded-md bg-canvas border border-glass-border text-[11px] text-ink placeholder:text-ink-muted/50 focus:outline-none focus:border-accent-lineage/40"
              />
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
            {filtered.length === 0 ? (
              <p className="text-xs text-ink-muted text-center py-8">No entities match “{query}”.</p>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const [eid, list] = filtered[vi.index]
                  const isDeleted = !!deleted[eid]
                  return (
                    <div
                      key={eid}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      className="pb-3"
                    >
                      <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-3">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-xs font-semibold text-ink font-mono truncate" title={eid}>{eid}</span>
                          <button
                            onClick={() => setDeleted((d) => ({ ...d, [eid]: !d[eid] }))}
                            className={cn(
                              'text-[10px] font-medium px-2 py-0.5 rounded-md border transition-colors shrink-0',
                              isDeleted
                                ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                                : 'border-glass-border text-ink-muted hover:text-rose-500 hover:border-rose-500/30',
                            )}
                          >
                            {isDeleted ? 'Will delete' : 'Delete instead'}
                          </button>
                        </div>
                        {!isDeleted && (
                          <div className="space-y-2.5">
                            {list.map((c) => {
                              const sel = picks[ckey(c)] ?? 'ours'
                              return (
                                <div key={ckey(c)}>
                                  <p className="text-[10px] uppercase tracking-wider text-ink-muted/70 mb-1 font-mono">
                                    {c.path.length ? c.path.join(' › ') : '(whole entity)'}
                                  </p>
                                  <div className="grid grid-cols-3 gap-1.5">
                                    {SIDES.map((side) => (
                                      <button
                                        key={side}
                                        onClick={() => setPicks((p) => ({ ...p, [ckey(c)]: side }))}
                                        className={cn(
                                          'rounded-lg border px-2 py-1.5 text-left transition-colors',
                                          sel === side
                                            ? 'border-accent-lineage/50 bg-accent-lineage/[0.06] ring-1 ring-accent-lineage/30'
                                            : 'border-glass-border bg-canvas hover:border-glass-border/80',
                                        )}
                                      >
                                        <span className={cn('block text-[10px] font-semibold mb-0.5', sel === side ? 'text-accent-lineage' : 'text-ink-muted')}>
                                          {SIDE_LABEL[side]}
                                        </span>
                                        <span className="block text-[11px] text-ink">
                                          <ValuePreview value={c[side]} />
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-between gap-3">
            <span className="text-[11px] truncate">
              {error ? (
                <span className="text-rose-500">{error}</span>
              ) : deletedCount > 0 ? (
                <span className="text-ink-muted">{deletedCount} marked for delete</span>
              ) : (
                <span />
              )}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                Cancel
              </button>
              <button
                onClick={() => onResolve(build())}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-60"
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Merge with resolutions
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
