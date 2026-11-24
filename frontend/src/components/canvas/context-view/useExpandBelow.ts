/**
 * useExpandBelow — open what is inside an entity (or a selection) one nested
 * level at a time, or every level, without a scheduler of its own.
 *
 * DELIBERATELY SMALL. A level is the containers not yet open at the shallowest
 * depth beneath the roots; opening it is ONE expansion update, and each of
 * those containers' first page comes through the loader the canvas already
 * has (`loadChildren`: its 6-slot queue, its merging of duplicate requests,
 * its Retry-After), or — given `loadFirstPages` — the whole level's together,
 * as few requests and canvas updates as that loader can make of them. Later
 * pages arrive through the column's Load more row as
 * the reader scrolls to them — so however many containers a level holds,
 * nothing off screen is drained early. "All levels" is the same step again
 * once a level's first pages have landed, until no containers are left — with
 * a checkpoint every CHECKPOINT_EVERY newly loaded entities, so a reader who
 * opened a warehouse of 100,000 tables decides, rather than the canvas, how
 * much of it to hold in memory. So that the pause comes near that number and
 * not a whole level past it, "All levels" opens a wide level in batches that
 * fit what is left before the next checkpoint. A depth limit stops a cycle the
 * graph should never have.
 *
 * Progress is one toast, keyed per run, updated in place: the level it is on
 * and what has loaded, with Cancel. Cancel stops the loop and the pages still
 * on their way; what already loaded stays — and the next "All levels" starts
 * at the shallowest level still closed, which is where this one stopped.
 *
 * At a checkpoint the toast is the run's question: Load 2,000 more, Load
 * everything (no more checkpoints — the depth limit and Cancel still stop it),
 * or Stop here, saying how many containers are still closed at the next
 * level. Closing it leaves the run paused, not stopped: `paused` says so, and
 * the canvas offers the same choices (`resume`, `cancel`) where the run was
 * started. A new expand replaces a paused run, as it does a running one.
 *
 * The same hook runs a trace, where the canvas hands it the overlay's tree:
 * it then opens only the cards the trace already holds, and fetches nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useNotificationStore } from '@/components/ui/notifications'

import type { ContextMenuAction } from '../CanvasContextMenu'

/** Newly loaded entities between checkpoints in an "All levels" run. */
export const CHECKPOINT_EVERY = 2_000
/** A paused run's choices, by the same names wherever they are offered. */
export const RESUME_LABELS = {
  more: `Load ${CHECKPOINT_EVERY.toLocaleString()} more`,
  all: 'Load everything',
  stop: 'Stop here',
} as const
/** No containment is this deep; a run that gets here is walking a cycle. */
export const MAX_EXPAND_DEPTH = 50

/** The tree the run walks, as the canvas holds it right now. */
export interface ExpandTree {
  /** Rows open now. */
  expanded: ReadonlySet<string>
  /** The children of a row that are loaded (or, in a trace, held). */
  childrenOf: (id: string) => readonly string[]
  /** Whether a row holds others — by its count, loaded or not. */
  isContainer: (id: string) => boolean
}

/**
 * The next level to open beneath `roots`: the closed containers at the
 * shallowest depth reached through open rows (a closed root is its own first
 * level). Empty when everything beneath is open.
 */
export function nextLevel(roots: readonly string[], tree: ExpandTree): { ids: string[]; depth: number } {
  const seen = new Set<string>()
  let frontier = roots.filter((id) => { if (seen.has(id)) return false; seen.add(id); return true })
  for (let depth = 0; frontier.length > 0 && depth <= MAX_EXPAND_DEPTH; depth++) {
    const closed = frontier.filter((id) => !tree.expanded.has(id) && tree.isContainer(id))
    if (closed.length > 0) return { ids: closed, depth }
    const below: string[] = []
    for (const id of frontier) {
      if (!tree.expanded.has(id)) continue
      for (const kid of tree.childrenOf(id)) {
        if (seen.has(kid)) continue
        seen.add(kid)
        below.push(kid)
      }
    }
    frontier = below
  }
  return { ids: [], depth: -1 }
}

/** Roots without one nested inside another — opening the outer opens the inner's level too. */
export function outermost(roots: readonly string[], parentOf: (id: string) => string | undefined): string[] {
  const set = new Set(roots)
  return [...set].filter((id) => {
    const seen = new Set<string>()
    for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) {
      if (set.has(p)) return false
      seen.add(p)
    }
    return true
  })
}

export interface ExpandBelowDeps extends ExpandTree {
  /** Open these rows, in one update. */
  open: (ids: readonly string[]) => void
  /** A row's parent, to drop a root nested inside another. */
  parentOf: (id: string) => string | undefined
  /** Fetch a container's first page; settles when it has landed. Called only
   *  for containers with nothing loaded. Absent in a trace: nothing to fetch. */
  loadFirstPage?: (id: string) => Promise<unknown>
  /** Fetch a whole level's first pages together, in as few requests as the
   *  loader can; settles when all have landed. Used in place of
   *  `loadFirstPage` when given. */
  loadFirstPages?: (ids: readonly string[]) => Promise<unknown>
  /** Stop a page still on its way. */
  cancelLoad?: (id: string) => void
  /** Pages still on their way, by container — a level has landed once none
   *  of its containers is in here. */
  loading: ReadonlySet<string>
  /** How many entities the canvas holds: what a checkpoint counts. */
  loadedCount: () => number
  /** About how many entities a container's first page brings — what "All
   *  levels" budgets a batch by. Absent: one each. */
  firstPageSize?: (id: string) => number
  /** A row's name, for the progress toast. */
  labelOf: (id: string) => string
}

/** A run waiting at a checkpoint: what its prompt says, for the canvas's own controls. */
export interface PausedRun {
  /** The rows it opens what is inside of (the outermost of those asked). */
  roots: readonly string[]
  /** "Paused opening “Warehouse” · 2,032 loaded so far" */
  message: string
  /** "312 containers still to open at level 4" */
  detail: string
}

/** Whether `paused` is the run these rows' Expand would start: the same roots. */
export function isPausedOn(paused: PausedRun | null, roots: readonly string[]): boolean {
  if (!paused || paused.roots.length !== roots.length) return false
  const own = new Set(paused.roots)
  return roots.every((id) => own.has(id))
}

/** A paused run's choices as the rows of a right-click menu. */
export function pausedMenuActions(paused: PausedRun, resume: (how: 'more' | 'all') => void, stop: () => void): ContextMenuAction[] {
  return [
    { id: 'expand-more', label: RESUME_LABELS.more, icon: 'ChevronsDown', hint: paused.detail, onClick: () => resume('more') },
    { id: 'expand-everything', label: RESUME_LABELS.all, icon: 'ArrowDownToLine', onClick: () => resume('all') },
    { id: 'expand-stop', label: RESUME_LABELS.stop, icon: 'CircleStop', onClick: stop },
  ]
}

interface Run {
  key: string
  roots: string[]
  all: boolean
  /** Load everything was chosen: no more checkpoints. */
  everything: boolean
  subject: string
  /** Levels opened so far. */
  levels: number
  /** The depth of the last level opened — the rows it made visible are at
   *  depth + 1 inside the roots, which is the "level" the reader is told. */
  depth: number
  /** Containers of the level waiting on their first page. */
  wave: string[]
  settled: boolean
  startCount: number
  checkpointBase: number
  paused: boolean
}

let runSeq = 0

/** " · 1,240 loaded", once the run has loaded anything. */
function loadedSoFar(deps: ExpandBelowDeps, run: Run): string {
  const loaded = deps.loadedCount() - run.startCount
  return loaded > 0 ? ` · ${loaded.toLocaleString()} loaded` : ''
}

export function useExpandBelow(deps: ExpandBelowDeps) {
  // The tree as of the last render: the run reads it after each level lands,
  // which is always a render later than the level was opened.
  const depsRef = useRef(deps)
  useEffect(() => { depsRef.current = deps })
  const runRef = useRef<Run | null>(null)
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState<PausedRun | null>(null)
  // A level's pages settled: re-render, so the check below reads the tree
  // they produced.
  const [tick, setTick] = useState(0)

  const toast = useCallback((run: Run, message: string, action: { label: string; onClick: () => void }) => {
    useNotificationStore.getState().add({ type: 'loading', key: run.key, message, action })
  }, [])

  const finish = useCallback((run: Run, message: string, type: 'success' | 'info' = 'success') => {
    if (runRef.current !== run) return
    runRef.current = null
    setRunning(false)
    setPaused(null)
    const store = useNotificationStore.getState()
    store.removeByKey(run.key)
    store.add({ type, message })
  }, [])

  const cancel = useCallback(() => {
    const run = runRef.current
    if (!run) return
    // What is still on its way stops; what has landed stays.
    for (const id of run.wave) if (depsRef.current.loading.has(id)) depsRef.current.cancelLoad?.(id)
    finish(run, `Stopped opening ${run.subject}${loadedSoFar(depsRef.current, run)}`, 'info')
  }, [finish])

  /** Open the next level of `run`, or end it when there is none. */
  const step = useCallback((run: Run) => {
    if (runRef.current !== run) return
    const d = depsRef.current
    const level = nextLevel(run.roots, d)
    if (level.ids.length === 0) {
      if (run.levels === 0) finish(run, `Everything inside ${run.subject} is already open`, 'info')
      else finish(run, `Opened everything inside ${run.subject}${loadedSoFar(d, run)}`)
      return
    }
    if (run.levels >= MAX_EXPAND_DEPTH) {
      finish(run, `Stopped at ${MAX_EXPAND_DEPTH} levels inside ${run.subject}${loadedSoFar(d, run)}`, 'info')
      return
    }
    // A new depth is a new level; a batch of the same one is not.
    if (level.depth !== run.depth) run.levels += 1
    run.depth = level.depth
    run.settled = false
    // "All levels": no more of a wide level at once than fits before the next
    // checkpoint — the rest is still the shallowest closed level next time.
    let ids = level.ids
    if (run.all && !run.everything) {
      let budget = CHECKPOINT_EVERY - (d.loadedCount() - run.checkpointBase)
      const batch: string[] = []
      for (const id of level.ids) {
        if (batch.length > 0 && budget <= 0) break
        batch.push(id)
        if (d.childrenOf(id).length === 0) budget -= Math.max(1, d.firstPageSize?.(id) ?? 1)
      }
      ids = batch
    }
    // One expansion update for the whole level (or batch); a first page only
    // where nothing is loaded yet.
    d.open(ids)
    const toLoad = d.loadFirstPage || d.loadFirstPages ? ids.filter((id) => d.childrenOf(id).length === 0) : []
    run.wave = toLoad
    const containers = ids.length < level.ids.length
      ? `${ids.length.toLocaleString()} of ${level.ids.length.toLocaleString()} containers`
      : `${ids.length.toLocaleString()} ${ids.length === 1 ? 'container' : 'containers'}`
    toast(run, `Opening ${run.subject} · level ${(level.depth + 1).toLocaleString()} · ${containers}${loadedSoFar(d, run)}`,
      { label: 'Cancel', onClick: cancel })
    const landing = d.loadFirstPages ? [d.loadFirstPages(toLoad)] : toLoad.map((id) => d.loadFirstPage!(id))
    void Promise.allSettled(landing).then(() => {
      if (runRef.current !== run) return
      run.settled = true
      setTick((t) => t + 1)
    })
  }, [cancel, finish, toast])

  /** Go on from a checkpoint: to the next one, or — 'all' — with no more of them. */
  const resume = useCallback((how: 'more' | 'all') => {
    const run = runRef.current
    if (!run?.paused) return
    run.paused = false
    run.everything = how === 'all'
    run.checkpointBase = depsRef.current.loadedCount()
    setPaused(null)
    step(run)
  }, [step])

  // A level landed (its pages settled and none is still on its way): one
  // level is done; "All levels" goes on, or stops at a checkpoint.
  useEffect(() => {
    const run = runRef.current
    if (!run || !run.settled || run.paused) return
    if (run.wave.some((id) => deps.loading.has(id))) return
    run.settled = false
    const d = depsRef.current
    if (!run.all) {
      finish(run, `Opened level ${(run.depth + 1).toLocaleString()} inside ${run.subject}${loadedSoFar(d, run)}`)
      return
    }
    // A checkpoint — unless the reader chose everything, or nothing is left to ask about.
    const level = !run.everything && d.loadedCount() - run.checkpointBase >= CHECKPOINT_EVERY
      ? nextLevel(run.roots, d)
      : null
    if (level && level.ids.length > 0) {
      run.paused = true
      const left = level.ids.length
      const prompt: PausedRun = {
        roots: run.roots,
        // The separator holds to what it follows: a line may break after it, never before.
        message: `Paused opening ${run.subject}\u00a0· ${(d.loadedCount() - run.startCount).toLocaleString()} loaded so far`,
        detail: `${left.toLocaleString()} ${left === 1 ? 'container' : 'containers'} still to open at level ${(level.depth + 1).toLocaleString()}`,
      }
      setPaused(prompt)
      useNotificationStore.getState().add({
        type: 'loading', paused: true, key: run.key, message: prompt.message, detail: prompt.detail,
        action: { label: RESUME_LABELS.more, onClick: () => resume('more') },
        secondaryAction: { label: RESUME_LABELS.all, onClick: () => resume('all') },
        tertiaryAction: { label: RESUME_LABELS.stop, onClick: cancel },
      })
      return
    }
    step(run)
  }, [tick, deps.loading, finish, step, cancel, resume])

  // Unmounting mid-run (a view switch) leaves no toast behind.
  useEffect(() => () => {
    const run = runRef.current
    if (run) useNotificationStore.getState().removeByKey(run.key)
    runRef.current = null
  }, [])

  /** Open the next level beneath `roots` — or, with `all`, every level. */
  const expand = useCallback((roots: readonly string[], all: boolean) => {
    if (runRef.current) cancel()
    const d = depsRef.current
    const outer = outermost(roots, d.parentOf)
    if (outer.length === 0) return
    const count = d.loadedCount()
    const run: Run = {
      key: `expand-below:${++runSeq}`,
      roots: outer,
      all,
      subject: outer.length === 1 ? `“${d.labelOf(outer[0]!)}”` : `${outer.length.toLocaleString()} entities`,
      levels: 0,
      depth: -1,
      wave: [],
      settled: false,
      startCount: count,
      checkpointBase: count,
      paused: false,
      everything: false,
    }
    runRef.current = run
    setRunning(true)
    step(run)
  }, [cancel, step])

  /** Whether a run is going (or paused), read at the moment it is asked
   *  (`running` is as of the last render). */
  const isRunning = useCallback(() => runRef.current !== null, [])

  /** `running`: a run is going or paused; `paused`: it waits at a checkpoint. */
  return { expand, cancel, resume, running, paused, isRunning }
}
