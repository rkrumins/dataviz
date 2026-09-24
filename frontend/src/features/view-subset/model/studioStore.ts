/**
 * The Subset Studio's state: which view a subset is being carved from, what
 * has been picked into it, and how it will be shaped.
 *
 * Deliberately NOT the canvas store. The studio runs on a live, published
 * view and must leave it exactly as it found it — picking is a lens over the
 * canvas, never an edit of it — so everything here is its own, and the
 * canvas only reads it.
 *
 * Kept per source view in sessionStorage, so a reload mid-curation brings
 * the picks back; an explicit Cancel, or making the view, clears them.
 */
import { create } from 'zustand'

import { DEFAULT_MAX_HOPS, MAX_HOPS_CAP, SUBSET_MEMBERS_MAX } from './limits'

/** How an entity came into the subset — the list and the canvas say so. */
export type PickOrigin = 'picked' | 'grown-up' | 'grown-down' | 'path' | 'outside'

export interface SubsetPick {
  urn: string
  /** The layer it will sit in: its layer in the source view, or where a
   *  layer rule (or the reader) placed an entity from outside the view. */
  layerId: string
  /** The group it sits in within that layer, when it came from one. */
  logicalNodeId?: string
  /** Takes in what sits beneath it (a table and its columns). */
  inheritsChildren: boolean
  origin: PickOrigin
  label: string
  entityType?: string
}

export type StudioStep = 'pick' | 'connect' | 'shape'

interface Snapshot {
  picks: Record<string, SubsetPick>
  order: string[]
}

interface UndoEntry extends Snapshot {
  label: string
}

interface StudioState extends Snapshot {
  /** The view the subset is carved from; null while the studio is closed. */
  sourceViewId: string | null
  step: StudioStep
  /** Grow may bring in entities from outside the source view. */
  reachBeyond: boolean
  /** How long a virtual hop may be, in raw lineage steps. */
  maxHops: number
  /** Carry each entity's group from the source view. */
  keepGroups: boolean
  undoStack: UndoEntry[]
  /** The reader asked to leave with picks in hand: the rail asks first. */
  confirmingCancel: boolean

  open: (sourceViewId: string, opts?: { maxHops?: number }) => void
  /** Leave the studio. `discard` also forgets the picks kept for a reload. */
  close: (opts?: { discard?: boolean }) => void
  /** Pick it, or take it back out. 'full' when the subset is at its cap. */
  toggle: (pick: SubsetPick) => 'added' | 'removed' | 'full'
  /** Add the ones not already in; returns how many were added (the cap may
   *  leave some out). */
  add: (picks: readonly SubsetPick[], label: string) => number
  remove: (urns: readonly string[], label: string) => void
  setInherits: (urns: readonly string[], value: boolean) => void
  undo: () => void
  setStep: (step: StudioStep) => void
  setReachBeyond: (on: boolean) => void
  setMaxHops: (hops: number) => void
  setKeepGroups: (on: boolean) => void
  /** Leave — at once with nothing picked, else once the reader confirms. */
  requestCancel: () => void
  dismissCancel: () => void
}

const UNDO_LIMIT = 50
const STORAGE_PREFIX = 'nx:subset-studio:'

interface Persisted extends Snapshot {
  step: StudioStep
  reachBeyond: boolean
  maxHops: number
  keepGroups: boolean
}

const EMPTY: Snapshot = { picks: {}, order: [] }

function readPersisted(viewId: string): Persisted | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + viewId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Persisted>
    if (!parsed || typeof parsed !== 'object' || !parsed.picks || !Array.isArray(parsed.order)) return null
    const picks = parsed.picks as Record<string, SubsetPick>
    return {
      picks,
      order: parsed.order.filter((u): u is string => typeof u === 'string' && !!picks[u]),
      step: parsed.step === 'connect' || parsed.step === 'shape' ? parsed.step : 'pick',
      reachBeyond: parsed.reachBeyond === true,
      maxHops: clampHops(parsed.maxHops ?? DEFAULT_MAX_HOPS),
      keepGroups: parsed.keepGroups !== false,
    }
  } catch {
    return null
  }
}

function writePersisted(viewId: string, state: Persisted): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + viewId, JSON.stringify(state))
  } catch { /* storage full or disabled: the studio still works, it just won't survive a reload */ }
}

function forgetPersisted(viewId: string): void {
  try { sessionStorage.removeItem(STORAGE_PREFIX + viewId) } catch { /* storage disabled */ }
}

function clampHops(n: number): number {
  return Math.max(1, Math.min(MAX_HOPS_CAP, Math.round(Number.isFinite(n) ? n : DEFAULT_MAX_HOPS)))
}

const CLOSED = {
  sourceViewId: null,
  ...EMPTY,
  step: 'pick' as StudioStep,
  reachBeyond: false,
  maxHops: DEFAULT_MAX_HOPS,
  keepGroups: true,
  undoStack: [] as UndoEntry[],
  confirmingCancel: false,
}

export const useSubsetStudioStore = create<StudioState>((set, get) => {
  /** Apply a change to the picks, remembering what it replaced. */
  const commit = (next: Snapshot, label: string) => {
    const { picks, order, undoStack } = get()
    set({ ...next, undoStack: [...undoStack, { picks, order, label }].slice(-UNDO_LIMIT) })
  }

  return {
    ...CLOSED,

    open: (sourceViewId, opts) => {
      const restored = readPersisted(sourceViewId)
      set({
        ...CLOSED,
        sourceViewId,
        ...(restored ?? { maxHops: clampHops(opts?.maxHops ?? DEFAULT_MAX_HOPS) }),
      })
    },

    close: (opts) => {
      const viewId = get().sourceViewId
      if (viewId && opts?.discard) forgetPersisted(viewId)
      set(CLOSED)
    },

    toggle: (pick) => {
      const { picks, order } = get()
      if (picks[pick.urn]) {
        const rest = { ...picks }
        delete rest[pick.urn]
        commit({ picks: rest, order: order.filter(u => u !== pick.urn) }, `Remove ${pick.label}`)
        return 'removed'
      }
      if (order.length >= SUBSET_MEMBERS_MAX) return 'full'
      commit({ picks: { ...picks, [pick.urn]: pick }, order: [...order, pick.urn] }, `Add ${pick.label}`)
      return 'added'
    },

    add: (incoming, label) => {
      const { picks, order } = get()
      const room = SUBSET_MEMBERS_MAX - order.length
      const seen = new Set<string>()
      const fresh = incoming.filter(p => {
        if (picks[p.urn] || seen.has(p.urn)) return false
        seen.add(p.urn)
        return true
      })
      const taken = fresh.slice(0, Math.max(0, room))
      if (taken.length === 0) return 0
      const nextPicks = { ...picks }
      for (const p of taken) nextPicks[p.urn] = p
      commit({ picks: nextPicks, order: [...order, ...taken.map(p => p.urn)] }, label)
      return taken.length
    },

    remove: (urns, label) => {
      const { picks, order } = get()
      const drop = new Set(urns.filter(u => picks[u]))
      if (drop.size === 0) return
      const nextPicks: Record<string, SubsetPick> = {}
      for (const u of order) if (!drop.has(u)) nextPicks[u] = picks[u]
      commit({ picks: nextPicks, order: order.filter(u => !drop.has(u)) }, label)
    },

    setInherits: (urns, value) => {
      const { picks, order } = get()
      const nextPicks = { ...picks }
      let changed = false
      for (const u of urns) {
        const p = nextPicks[u]
        if (p && p.inheritsChildren !== value) { nextPicks[u] = { ...p, inheritsChildren: value }; changed = true }
      }
      if (changed) {
        commit({ picks: nextPicks, order }, value ? 'Include what sits inside' : 'Leave out what sits inside')
      }
    },

    undo: () => {
      const { undoStack } = get()
      const last = undoStack[undoStack.length - 1]
      if (!last) return
      set({ picks: last.picks, order: last.order, undoStack: undoStack.slice(0, -1) })
    },

    setStep: (step) => set({ step }),
    setReachBeyond: (reachBeyond) => set({ reachBeyond }),
    setMaxHops: (hops) => set({ maxHops: clampHops(hops) }),
    setKeepGroups: (keepGroups) => set({ keepGroups }),
    requestCancel: () => {
      if (get().order.length === 0) get().close({ discard: true })
      else set({ confirmingCancel: true })
    },
    dismissCancel: () => set({ confirmingCancel: false }),
  }
})

// Every change a reader makes survives a reload of the same view.
useSubsetStudioStore.subscribe((state) => {
  if (!state.sourceViewId) return
  writePersisted(state.sourceViewId, {
    picks: state.picks,
    order: state.order,
    step: state.step,
    reachBeyond: state.reachBeyond,
    maxHops: state.maxHops,
    keepGroups: state.keepGroups,
  })
})

/** The picks in the order they were made. */
export function orderedPicks(state: Pick<StudioState, 'picks' | 'order'>): SubsetPick[] {
  return state.order.map(u => state.picks[u]).filter((p): p is SubsetPick => !!p)
}
