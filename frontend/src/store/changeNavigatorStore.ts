/**
 * changeNavigatorStore — the canvas change navigator: a sequence of changed entities and where in
 * it the reader is. Stepping reveals each on the canvas (the `ChangeNavigator` the canvas renders
 * does that); anything can start it — Review & Save's "Step through", a change list's "Show on
 * canvas", the bar's change counts. Not persisted: it is a walk, not state to keep.
 *
 * A sequence comes from a source: the staged changes, held in memory, or the changes a draft has
 * saved — read from the server's change list a page at a time, with their names, however many
 * there are (up to what a change list can list).
 */
import { create } from 'zustand'
import type { ChangeStatus } from '@/features/versioning/model/changeModel'
import type { ReviewGroup } from '@/features/versioning/model/reviewModel'
import {
  getChangeEntries, type ChangeListFilter, type ChangeListOrigin, type ChangeListRow,
} from '@/services/versioningApiService'

export interface NavStop {
  /** The canvas's id for the entity (its urn). */
  id: string
  name: string
  status: ChangeStatus
  /** Saved on the draft (else staged, not saved yet). */
  saved: boolean
}

export type NavScope = 'unsaved' | 'saved' | 'all'

/** Where a sequence's stops come from. */
export interface NavSource {
  /** How many stops; unknown (-1) until the first page is read. */
  readonly total: number
  /** The stop at `i`, when it is in hand. */
  at(i: number): NavStop | undefined
  /** Bring the stop at `i` into hand (and the page after it, when near). */
  ensure(i: number): void
  /** Reading the stop at `i` failed — try again with `ensure`. */
  failed(i: number): boolean
  /** More than a change list lists: counted, not stepped through. */
  readonly tooLarge: boolean
  /** Told when a page arrives (or fails). */
  onChange?: () => void
}

interface ChangeNavigatorState {
  active: boolean
  source: NavSource | null
  index: number
  scope: NavScope
  /** The sequence is a filtered part of its scope (Review & Save's or a change list's filter). */
  narrowed: boolean
  /** Bumped when a page arrives, so what shows it draws again. */
  version: number
  /** A canvas is there to step through (the navigator is mounted). */
  canReveal: boolean
  /** Walk `source` (or these stops), from position `at` (or the stop with id `atId`). */
  start: (source: NavSource | NavStop[], opts: { scope: NavScope; at?: number; atId?: string; narrowed?: boolean }) => void
  go: (index: number) => void
  next: () => void
  prev: () => void
  close: () => void
  setCanReveal: (can: boolean) => void
}

export const useChangeNavigatorStore = create<ChangeNavigatorState>((set, get) => ({
  active: false,
  source: null,
  index: 0,
  scope: 'unsaved',
  narrowed: false,
  version: 0,
  canReveal: false,
  start: (input, { scope, at, atId, narrowed = false }) => {
    const source = Array.isArray(input) ? arraySource(input) : input
    if (source.total === 0) return
    const i = at ?? (atId && Array.isArray(input) ? Math.max(0, input.findIndex((s) => s.id === atId)) : 0)
    source.onChange = () => { if (get().source === source) set((s) => ({ version: s.version + 1 })) }
    source.ensure(i)
    set({ active: true, source, index: i, scope, narrowed })
  },
  go: (index) => {
    const { source } = get()
    if (!source) return
    const last = source.total < 0 ? index : source.total - 1
    const i = Math.max(0, Math.min(last, index))
    source.ensure(i)
    set({ index: i })
  },
  next: () => get().go(get().index + 1),
  prev: () => get().go(get().index - 1),
  close: () => set({ active: false }),
  setCanReveal: (canReveal) => set({ canReveal }),
}))

/** Stops held in memory. */
export function arraySource(stops: readonly NavStop[]): NavSource {
  return { total: stops.length, tooLarge: false, at: (i) => stops[i], ensure: () => {}, failed: () => false }
}

/** Review & Save's groups as stops: the entities on the canvas (a deleted one has none to show). */
export function stopsFromGroups(groups: readonly ReviewGroup[]): NavStop[] {
  const out: NavStop[] = []
  for (const g of groups) if (g.kind === 'node' && g.revealId) out.push({ id: g.revealId, name: g.name, status: g.status, saved: false })
  return out
}

/** Stops read a page at a time. */
export const NAV_PAGE = 500

/** A change list row as a stop: by the canvas's name for it (its urn), called what it is called. */
const stopOf = (row: ChangeListRow, saved: boolean): NavStop => ({
  id: row.urn ?? row.entityId,
  name: row.displayName || row.qualifiedName || row.urn || row.entityId,
  status: row.status,
  saved,
})

/**
 * The entities a change list holds that are still there to show (added or edited), read from the
 * server a page of {@link NAV_PAGE} at a time — with their names — and the next page read as the
 * walk nears it. `filter` narrows it as the list it came from is narrowed.
 */
export function changeListSource(
  wsId: string, graphId: string, origin: ChangeListOrigin, filter: ChangeListFilter = {},
): NavSource {
  const statuses = (filter.statuses?.length ? filter.statuses : ['added', 'modified'] as const)
    .filter((s) => s !== 'removed')
  const saved = 'branchId' in origin
  const pages = new Map<number, NavStop[]>()
  const reading = new Set<number>()
  const failedPages = new Set<number>()
  const src: NavSource & { total: number; tooLarge: boolean } = {
    total: -1,
    tooLarge: false,
    at: (i) => pages.get(Math.floor(i / NAV_PAGE))?.[i % NAV_PAGE],
    failed: (i) => failedPages.has(Math.floor(i / NAV_PAGE)),
    ensure: (i) => {
      const n = Math.floor(i / NAV_PAGE)
      read(n)
      if (i % NAV_PAGE >= NAV_PAGE - 50) read(n + 1)
    },
  }
  function read(n: number) {
    if (pages.has(n) || reading.has(n) || (src.total >= 0 && n * NAV_PAGE >= src.total)) return
    reading.add(n)
    failedPages.delete(n)
    getChangeEntries(wsId, graphId, origin, { ...filter, kind: 'node', statuses: [...statuses] }, n * NAV_PAGE, NAV_PAGE)
      .then((page) => {
        src.total = page.total
        src.tooLarge = !!page.tooLarge && page.total === 0
        pages.set(n, page.entries.map((r) => stopOf(r, saved)))
      })
      .catch(() => { failedPages.add(n) })
      .finally(() => { reading.delete(n); src.onChange?.() })
  }
  return src
}

/** Two sources one after the other: Unsaved, then Saved. */
export function concatSources(a: NavSource, b: NavSource): NavSource {
  const src: NavSource = {
    get total() { return a.total < 0 || b.total < 0 ? -1 : a.total + b.total },
    get tooLarge() { return b.tooLarge },
    at: (i) => (i < a.total ? a.at(i) : b.at(i - a.total)),
    failed: (i) => (i < a.total ? a.failed(i) : b.failed(i - a.total)),
    ensure: (i) => (i < a.total ? a.ensure(i) : b.ensure(i - a.total)),
  }
  a.onChange = b.onChange = () => src.onChange?.()
  b.ensure(0)   // its count, for "of N"
  return src
}
