/**
 * ConflictResolver — resolve a pull/merge's conflicts visually, then re-merge.
 *
 * The backend reports conflicts as `{entity_id, path, base, ours, theirs}` (a field slice, or a
 * whole-entity delete/modify when path is empty), and accepts resolutions as whole-entity payloads
 * (`{entityId: payload | null}`). Per entity we seed the working payload from the merged result
 * (the diff's `after`) and overlay each picked value; `buildResolutions` maps an accepted deletion
 * to `null` (never `{}` — that would land as a live identity-less node and crash later reads).
 *
 * UX goals: read like a review, not a JSON dump.
 *   • each entity shows its type + name, with its conflicts grouped under it;
 *   • a field conflict shows the value Original → (Your version | Incoming), tagging which side
 *     actually changed it, so "what changed from what to what" is obvious;
 *   • a delete/modify conflict is called out with a warning and a clear keep-vs-delete choice;
 *   • bulk "keep all mine / take all incoming" + search scale it to 100s–1000s of conflicts.
 *
 * Portal/close note: this renders through a portal to `document.body`, but call sites (BranchSwitcher)
 * use a native `document` "mousedown outside → close" listener. We stop `mousedown`/`pointerdown` at
 * the modal root so they never reach those listeners (we leave `click` alone so buttons still fire).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle, Box, Columns3, Database, Folder, GitBranch, Loader2, Search, Trash2, Undo2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ResolutionMap } from '@/services/versioningApiService'
import {
  type Conflict, type Side, normalizeConflict, conflictKey as ckey, groupByEntity,
  buildResolutions, isDeleteModify,
} from '../conflictResolution'

// "ours" = the work you're merging in; "theirs" = what's already on the target (main).
const SIDE_LABEL: Record<Side, string> = { ours: 'Your version', theirs: 'Incoming', base: 'Original' }

// ── presentational helpers (keep the card human, not technical) ──────────────────────────────────
function iconForType(t: string) {
  const k = t.toLowerCase()
  if (k.includes('container') || k.includes('database')) return Folder
  if (k.includes('field') || k.includes('column')) return Columns3
  if (k.includes('dataset') || k.includes('table')) return Database
  if (k.includes('edge') || k.includes('lineage') || k.includes('relationship')) return GitBranch
  return Box
}

// Literal class strings per side — Tailwind's JIT only sees complete class names, never interpolated.
const SIDE_STYLE: Record<'ours' | 'theirs', { sel: string; text: string }> = {
  ours: { sel: 'border-accent-lineage/50 bg-accent-lineage/[0.07] ring-1 ring-accent-lineage/30', text: 'text-accent-lineage' },
  theirs: { sel: 'border-violet-500/50 bg-violet-500/[0.07] ring-1 ring-violet-500/30', text: 'text-violet-500' },
}

function humanizeField(path: (string | number)[]): string {
  if (!path.length) return 'Whole entity'
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : String(p)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase())))
    .join(' › ')
}

function fmtValue(v: unknown): { text: string; muted: boolean } {
  if (v === undefined || v === null) return { text: '— removed —', muted: true }
  if (typeof v === 'string') return v ? { text: v, muted: false } : { text: '(empty)', muted: true }
  if (Array.isArray(v)) return v.length ? { text: v.map(String).join(', '), muted: false } : { text: '(none)', muted: true }
  if (typeof v === 'object') return { text: JSON.stringify(v), muted: false }
  return { text: String(v), muted: false }
}

function ValueText({ value }: { value: unknown }) {
  const { text, muted } = fmtValue(value)
  return <span className={cn('break-all line-clamp-3', muted ? 'italic text-ink-muted/60' : 'text-ink')}>{text}</span>
}

/** Resolve an entity's display type + name from any payload we have (seed or a whole-entity slice). */
function entityMeta(eid: string, list: Conflict[], seed?: Record<string, unknown>) {
  const payloads = [seed, ...list.flatMap((c) => (c.path.length === 0 ? [c.ours, c.base, c.theirs] : []))]
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
  const type = (payloads.map((p) => p.entityType).find(Boolean) as string) || 'entity'
  const name = (payloads.map((p) => p.displayName).find(Boolean) as string) || eid.split(':').pop() || eid
  return { type, name }
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

  const [picks, setPicks] = useState<Record<string, Side>>({})
  const [deleted, setDeleted] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')

  // Default every field/whole-entity pick to "ours" (your branch wins by default; review to take
  // incoming) — and never lose a pick when a retry returns a smaller conflict set.
  useEffect(() => {
    setPicks((prev) => {
      const next: Record<string, Side> = {}
      for (const c of normalized) next[ckey(c)] = prev[ckey(c)] ?? 'ours'
      return next
    })
  }, [normalized])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allEntries
    return allEntries.filter(([eid, list]) =>
      eid.toLowerCase().includes(q) || entityMeta(eid, list, seeds[eid]).name.toLowerCase().includes(q))
  }, [allEntries, query, seeds])

  // Bulk over ALL entities (not just the filtered view). "Take all incoming" on a delete/modify
  // accepts the deletion; "Keep all mine" keeps/​resurrects your version. Clears delete toggles.
  const takeAll = (side: Side) => {
    setPicks(Object.fromEntries(normalized.map((c) => [ckey(c), side])))
    setDeleted({})
  }

  // How many entities will end up deleted (explicit toggle, or an accepted upstream deletion).
  const willDelete = useMemo(() => {
    let n = 0
    for (const [eid, list] of allEntries) {
      if (deleted[eid]) { n++; continue }
      const dm = list.find(isDeleteModify)
      if (dm && (dm[picks[ckey(dm)] ?? 'ours'] == null)) n++
    }
    return n
  }, [allEntries, deleted, picks])

  const build = (): ResolutionMap => buildResolutions(byEntity, picks, deleted, seeds)

  const scrollRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 150,
    overscan: 6,
    getItemKey: (i) => filtered[i][0],
  })

  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    el.addEventListener('mousedown', stop)
    el.addEventListener('pointerdown', stop)
    return () => { el.removeEventListener('mousedown', stop); el.removeEventListener('pointerdown', stop) }
  }, [])

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={rootRef}
        key="conflict-resolver"
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onCancel}
      >
        <motion.div
          className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
          initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-glass-border/60">
            <div className="flex items-start gap-2.5">
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 shrink-0">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-ink">
                  Resolve {normalized.length} {normalized.length === 1 ? 'conflict' : 'conflicts'}
                  {byEntity.size > 1 && <span className="text-ink-muted font-normal"> across {byEntity.size} entities</span>}
                </h3>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Main changed under your work. For each, choose <span className="text-accent-lineage font-medium">your version</span> or the <span className="text-violet-500 font-medium">incoming</span> one, then merge.
                </p>
              </div>
            </div>
            <button onClick={onCancel} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Toolbar: bulk + search */}
          <div className="flex items-center gap-2 px-5 py-2.5 border-b border-glass-border/60 bg-canvas-elevated/30">
            <button
              onClick={() => takeAll('ours')}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-accent-lineage/30 text-accent-lineage hover:bg-accent-lineage/[0.08] transition-colors"
            >
              Keep all mine
            </button>
            <button
              onClick={() => takeAll('theirs')}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-violet-500/30 text-violet-500 hover:bg-violet-500/[0.08] transition-colors"
            >
              Take all incoming
            </button>
            <div className="relative ml-auto">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60 pointer-events-none" />
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter entities…"
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
                  return (
                    <div
                      key={eid} data-index={vi.index} ref={rowVirtualizer.measureElement}
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      className="pb-3"
                    >
                      <EntityCard
                        eid={eid} list={list} seed={seeds[eid]}
                        picks={picks} setPicks={setPicks}
                        deleted={!!deleted[eid]} setDeleted={setDeleted}
                      />
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
              ) : willDelete > 0 ? (
                <span className="text-rose-500/90 inline-flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> {willDelete} {willDelete === 1 ? 'entity' : 'entities'} will be deleted
                </span>
              ) : (
                <span />
              )}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                Cancel
              </button>
              <button
                onClick={() => onResolve(build())} disabled={busy}
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

// ── one entity's conflicts ───────────────────────────────────────────────────────────────────────
function EntityCard({
  eid, list, seed, picks, setPicks, deleted, setDeleted,
}: {
  eid: string
  list: Conflict[]
  seed?: Record<string, unknown>
  picks: Record<string, Side>
  setPicks: React.Dispatch<React.SetStateAction<Record<string, Side>>>
  deleted: boolean
  setDeleted: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}) {
  const { type, name } = entityMeta(eid, list, seed)
  const Icon = iconForType(type)
  const dm = list.find(isDeleteModify)

  return (
    <div className={cn('rounded-xl border bg-canvas-elevated/40 p-3',
      deleted ? 'border-rose-500/30' : dm ? 'border-amber-500/30' : 'border-glass-border')}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex items-center justify-center w-6 h-6 rounded-md bg-canvas-overlay shrink-0">
            <Icon className="w-3.5 h-3.5 text-ink-muted" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink truncate" title={eid}>{name}</p>
            <p className="text-[10px] text-ink-muted/70 capitalize">{type}</p>
          </div>
        </div>
        {!dm && (
          <button
            onClick={() => setDeleted((d) => ({ ...d, [eid]: !d[eid] }))}
            className={cn('text-[10px] font-medium px-2 py-0.5 rounded-md border transition-colors shrink-0',
              deleted ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                : 'border-glass-border text-ink-muted hover:text-rose-500 hover:border-rose-500/30')}
          >
            {deleted ? 'Will delete' : 'Delete instead'}
          </button>
        )}
      </div>

      {deleted ? (
        <p className="text-[11px] text-rose-500/80 px-1 pb-1">This entity will be deleted on merge.</p>
      ) : dm ? (
        <DeleteModifyChoice dm={dm} side={picks[ckey(dm)] ?? 'ours'}
          onPick={(s) => setPicks((p) => ({ ...p, [ckey(dm)]: s }))} />
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <FieldConflict key={ckey(c)} c={c} side={picks[ckey(c)] ?? 'ours'}
              onPick={(s) => setPicks((p) => ({ ...p, [ckey(c)]: s }))} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── delete/modify: the entity you edited was deleted upstream ────────────────────────────────────
function DeleteModifyChoice({ dm, side, onPick }: { dm: Conflict; side: Side; onPick: (s: Side) => void }) {
  // The surviving (modified) side and the deleted side — direction-agnostic.
  const youDeleted = dm.ours == null            // you deleted it; main modified it
  const keptSide: Side = youDeleted ? 'theirs' : 'ours'
  const delSide: Side = youDeleted ? 'ours' : 'theirs'
  const kept = dm[keptSide] as Record<string, unknown> | undefined
  const keptName = (kept?.displayName as string) || ''

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
      <p className="text-[11px] text-amber-700 dark:text-amber-300 font-medium mb-2 inline-flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" />
        {youDeleted
          ? 'You deleted this, but main changed it.'
          : 'Deleted on main, but you edited it.'}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => onPick(keptSide)}
          className={cn('rounded-lg border px-2.5 py-2 text-left transition-colors',
            side === keptSide ? 'border-accent-lineage/50 bg-accent-lineage/[0.08] ring-1 ring-accent-lineage/30'
              : 'border-glass-border bg-canvas hover:border-glass-border/80')}
        >
          <span className="block text-[10px] font-semibold text-accent-lineage mb-0.5">Keep it</span>
          <span className="block text-[11px] text-ink truncate">{keptName || 'restore this entity'}</span>
        </button>
        <button
          onClick={() => onPick(delSide)}
          className={cn('rounded-lg border px-2.5 py-2 text-left transition-colors',
            side === delSide ? 'border-rose-500/50 bg-rose-500/[0.08] ring-1 ring-rose-500/30'
              : 'border-glass-border bg-canvas hover:border-rose-500/30')}
        >
          <span className="block text-[10px] font-semibold text-rose-500 mb-0.5 inline-flex items-center gap-1">
            <Trash2 className="w-3 h-3" /> Accept deletion
          </span>
          <span className="block text-[11px] text-ink-muted truncate">discard the changes</span>
        </button>
      </div>
    </div>
  )
}

// ── a single conflicting field: Original → (Your version | Incoming) ──────────────────────────────
function FieldConflict({ c, side, onPick }: { c: Conflict; side: Side; onPick: (s: Side) => void }) {
  const youChanged = JSON.stringify(c.ours) !== JSON.stringify(c.base)
  const mainChanged = JSON.stringify(c.theirs) !== JSON.stringify(c.base)
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-muted/70 mb-1 font-medium">{humanizeField(c.path)}</p>
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px]">
        <span className="text-ink-muted/60 shrink-0">was</span>
        <span className="min-w-0"><ValueText value={c.base} /></span>
        <button
          onClick={() => onPick('base')}
          title="Keep the original value"
          className={cn('ml-auto shrink-0 p-1 rounded transition-colors',
            side === 'base' ? 'text-ink bg-canvas-overlay' : 'text-ink-muted/50 hover:text-ink-muted')}
        >
          <Undo2 className="w-3 h-3" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {(['ours', 'theirs'] as const).map((s) => {
          const changed = s === 'ours' ? youChanged : mainChanged
          const sel = side === s
          return (
            <button
              key={s} onClick={() => onPick(s)}
              className={cn('rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                sel ? SIDE_STYLE[s].sel : 'border-glass-border bg-canvas hover:border-glass-border/80')}
            >
              <span className={cn('flex items-center justify-between text-[10px] font-semibold mb-0.5',
                sel ? SIDE_STYLE[s].text : 'text-ink-muted')}>
                {SIDE_LABEL[s]}
                {changed && <span className="text-[9px] font-normal text-ink-muted/60">changed</span>}
              </span>
              <span className="block text-[11px]"><ValueText value={c[s]} /></span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
