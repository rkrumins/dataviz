/**
 * ConflictResolver — resolve a PR's field-level merge conflicts, then re-merge.
 *
 * The backend reports conflicts as `{entity_id, path, base, ours, theirs}` (a field slice),
 * but the merge API takes resolutions as a map of **whole-entity payloads**
 * (`{entityId: payload | null}`). So per conflicted entity we seed the working payload from
 * the merged result (the diff's `after`, which already has every non-conflicting field) and
 * overlay the user's per-field pick via an immutable `setIn`. Picking "Delete" resolves the
 * entity to `null`.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ResolutionMap } from '@/services/versioningApiService'

type Side = 'theirs' | 'ours' | 'base'

interface Conflict {
  entity_id: string
  path: (string | number)[]
  base?: unknown
  ours?: unknown
  theirs?: unknown
  kind?: string
}

/** Normalise a raw backend conflict (snake_case, possibly camelCase) into our shape. */
function normalize(raw: Record<string, unknown>): Conflict {
  return {
    entity_id: String(raw.entity_id ?? raw.entityId ?? ''),
    path: (raw.path as (string | number)[]) ?? [],
    base: raw.base,
    ours: raw.ours,
    theirs: raw.theirs,
    kind: raw.kind as string | undefined,
  }
}

/** Immutable deep-set of `value` at `path` within `obj`. Empty path replaces the whole entity. */
function setIn(obj: Record<string, unknown>, path: (string | number)[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return (value ?? {}) as Record<string, unknown>
  const [head, ...rest] = path
  const clone: any = Array.isArray(obj) ? [...obj] : { ...obj }
  clone[head] = rest.length === 0 ? value : setIn((clone[head] ?? {}) as Record<string, unknown>, rest, value)
  return clone
}

const SIDE_LABEL: Record<Side, string> = { theirs: 'Current target', ours: 'This PR', base: 'Original' }
const ckey = (c: Conflict) => `${c.entity_id}::${c.path.join('.')}`

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
  const normalized = useMemo(() => conflicts.map((c) => normalize(c)).filter((c) => c.entity_id), [conflicts])
  const byEntity = useMemo(() => {
    const m = new Map<string, Conflict[]>()
    for (const c of normalized) {
      const arr = m.get(c.entity_id)
      if (arr) arr.push(c)
      else m.set(c.entity_id, [c])
    }
    return m
  }, [normalized])

  // Per-field pick (default: take this PR's change) + per-entity delete toggle.
  const [picks, setPicks] = useState<Record<string, Side>>(() =>
    Object.fromEntries(normalized.map((c) => [ckey(c), 'ours' as Side])),
  )
  const [deleted, setDeleted] = useState<Record<string, boolean>>({})

  const build = (): ResolutionMap => {
    const res: ResolutionMap = {}
    for (const [eid, list] of byEntity) {
      if (deleted[eid]) {
        res[eid] = null
        continue
      }
      let payload: Record<string, unknown> = { ...(seeds[eid] ?? {}) }
      for (const c of list) {
        const side = picks[ckey(c)] ?? 'ours'
        payload = setIn(payload, c.path, c[side])
      }
      res[eid] = payload
    }
    return res
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onCancel}
      >
        <motion.div
          className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-canvas border border-glass-border shadow-2xl overflow-hidden"
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

          <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
            {[...byEntity.entries()].map(([eid, list]) => (
              <div key={eid} className="rounded-xl border border-glass-border bg-canvas-elevated/40 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold text-ink font-mono truncate" title={eid}>{eid}</span>
                  <button
                    onClick={() => setDeleted((d) => ({ ...d, [eid]: !d[eid] }))}
                    className={cn(
                      'text-[10px] font-medium px-2 py-0.5 rounded-md border transition-colors shrink-0',
                      deleted[eid]
                        ? 'bg-rose-500/10 text-rose-500 border-rose-500/30'
                        : 'border-glass-border text-ink-muted hover:text-rose-500 hover:border-rose-500/30',
                    )}
                  >
                    {deleted[eid] ? 'Will delete' : 'Delete instead'}
                  </button>
                </div>
                {!deleted[eid] && (
                  <div className="space-y-2.5">
                    {list.map((c) => {
                      const sel = picks[ckey(c)] ?? 'ours'
                      const sides: Side[] = ['theirs', 'ours', 'base']
                      return (
                        <div key={ckey(c)}>
                          <p className="text-[10px] uppercase tracking-wider text-ink-muted/70 mb-1 font-mono">
                            {c.path.length ? c.path.join(' › ') : '(whole entity)'}
                          </p>
                          <div className="grid grid-cols-3 gap-1.5">
                            {sides.map((side) => (
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
            ))}
          </div>

          <div className="px-5 py-3.5 border-t border-glass-border/60 flex items-center justify-between gap-3">
            {error ? <span className="text-[11px] text-rose-500 truncate">{error}</span> : <span />}
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
