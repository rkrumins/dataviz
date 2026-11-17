/**
 * changeNavigatorStore — the canvas change navigator: a sequence of changed entities and where in
 * it the reader is. Stepping reveals each on the canvas (the `ChangeNavigator` the canvas renders
 * does that); anything can start it — Review & Save's "Step through", a change list's "Show on
 * canvas", the bar's change counts. Not persisted: it is a walk, not state to keep.
 */
import { create } from 'zustand'
import type { ChangeSet, ChangeStatus } from '@/features/versioning/model/changeModel'
import type { ReviewGroup } from '@/features/versioning/model/reviewModel'

export interface NavStop {
  /** The canvas's id for the entity (its urn). */
  id: string
  name: string
  status: ChangeStatus
  /** Saved on the draft (else staged, not saved yet). */
  saved: boolean
}

export type NavScope = 'unsaved' | 'saved' | 'all'

interface ChangeNavigatorState {
  active: boolean
  stops: NavStop[]
  index: number
  scope: NavScope
  /** The sequence is a filtered part of its scope (Review & Save's filter). */
  narrowed: boolean
  /** A canvas is there to step through (the navigator is mounted). */
  canReveal: boolean
  /** Walk `stops`, from the one with id `at` (else the first). */
  start: (stops: NavStop[], opts: { scope: NavScope; at?: string; narrowed?: boolean }) => void
  go: (index: number) => void
  next: () => void
  prev: () => void
  close: () => void
  setCanReveal: (can: boolean) => void
}

export const useChangeNavigatorStore = create<ChangeNavigatorState>((set, get) => ({
  active: false,
  stops: [],
  index: 0,
  scope: 'unsaved',
  narrowed: false,
  canReveal: false,
  start: (stops, { scope, at, narrowed = false }) => {
    const i = at ? stops.findIndex((s) => s.id === at) : 0
    set({ active: stops.length > 0, stops, index: Math.max(0, i), scope, narrowed })
  },
  go: (index) => {
    const { stops } = get()
    if (stops.length) set({ index: Math.max(0, Math.min(stops.length - 1, index)) })
  },
  next: () => get().go(get().index + 1),
  prev: () => get().go(get().index - 1),
  close: () => set({ active: false }),
  setCanReveal: (canReveal) => set({ canReveal }),
}))

/** Review & Save's groups as stops: the entities on the canvas (a deleted one has none to show). */
export function stopsFromGroups(groups: readonly ReviewGroup[]): NavStop[] {
  const out: NavStop[] = []
  for (const g of groups) if (g.kind === 'node' && g.revealId) out.push({ id: g.revealId, name: g.name, status: g.status, saved: false })
  return out
}

const savedCache = new WeakMap<ChangeSet, NavStop[]>()
/** The entities a draft has saved changes to, removed ones aside — built once per change set. */
export function savedStops(cs: ChangeSet | null): NavStop[] {
  if (!cs) return []
  let out = savedCache.get(cs)
  if (!out) {
    out = []
    for (const c of cs.changes) {
      if (c.kind !== 'node' || c.status === 'removed') continue
      out.push({ id: c.urn ?? c.entityId, name: c.label, status: c.status, saved: true })
    }
    savedCache.set(cs, out)
  }
  return out
}

/** Unsaved first, then what is saved and not also staged. */
export function allStops(unsaved: readonly NavStop[], saved: readonly NavStop[]): NavStop[] {
  const seen = new Set(unsaved.map((s) => s.id))
  return [...unsaved, ...saved.filter((s) => !seen.has(s.id))]
}
