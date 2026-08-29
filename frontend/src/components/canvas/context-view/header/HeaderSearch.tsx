/**
 * HeaderSearch — the Context View header's search box.
 *
 * It holds no state. Every gesture is a call on the canvas's one search
 * session (`ViewSearchSessionContext`), which debounces the text, runs it
 * against the WHOLE view server-side, publishes the highlights and opens
 * the results panel. What the box renders back is that session's state:
 * the text, the scope chip, and one status line.
 *
 * This replaces a client-side filter over the entities that happened to
 * be loaded on the canvas. That filter could only ever find what was
 * already on screen, so the honest thing to do with a miss was to offer
 * an escalation card pointing at "Advanced Search" — a second search
 * surface with a second query. Both are gone: there is one query now, and
 * the panel is where its results live.
 *
 * What the box adds on top of the session is the LIST under it. "Top
 * matches" is the first tier of the search: the ten best hits with the
 * path to each one on the canvas, driven entirely from the keyboard. It
 * replaced the results panel opening itself on every first result set —
 * an answer that took over a whole rail for a question most often
 * settled by "that one". The panel is still there behind "See all".
 *
 * The rules live HERE and the surface (`search/SearchDropdown`) draws
 * them: when the list is open, which row is active, what each key does,
 * what a pick means. That split is what makes the rules testable without
 * a portal and the surface testable without a session.
 *
 * "Look in" and "Match" are two anchored lists built the way
 * `DisplayMenu` builds its popover (portal + framer-motion, no
 * AnimatePresence — an interrupted exit strands an invisible
 * click-blocker). The property keys under "Look in" are fetched when that
 * menu opens, not on every canvas render: `/search/discover` is a real
 * request, and a menu nobody opened should not pay for one.
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import type { SearchHit } from '@/types/search'
import { useDiscovery } from '../../search/builder/useDiscovery'
import { TEXT_MATCH_OPTIONS } from '../../search/panel/ConditionRow'
import type { QuickLookIn, QuickMatch } from '../../search/session/quickPredicate'
import { useViewSearchSession } from '../../search/session/ViewSearchSessionContext'
import { hasReportableView } from '../../search/session/useViewSearchSessionController'
import { SearchDropdown, optionId } from './search/SearchDropdown'
import { topMatches } from './search/dropdownModel'

const FIXED_LOOK_IN: { value: QuickLookIn; label: string }[] = [
  { value: 'everything', label: 'Everything' },
  { value: 'name', label: 'Name' },
  { value: 'description', label: 'Description' },
  { value: 'tags', label: 'Tags' },
]

/** The builder's own labels, minus the wildcard entry: the box has no
 *  place to explain pattern syntax, and the four plain modes cover it. */
const MATCH_OPTIONS = TEXT_MATCH_OPTIONS
  .filter((o) => o.value !== 'wildcard')
  .map((o) => ({ value: o.value as QuickMatch, label: o.label }))

/** What a click can move focus to on its own. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Long enough that arrowing THROUGH a row costs nothing, short enough
 *  that a row the user has actually stopped on is warm by the time they
 *  press ↵. */
const PREFETCH_MS = 150

/** How long the box says where a reveal landed before going back to
 *  reporting the count. */
const LANDING_NOTE_MS = 4000

/** Marks the portalled list, so the box's outside-click handler can tell
 *  "clicked away" from "clicked in the list" across the portal. */
const DROPDOWN_MARK = 'data-view-search-dropdown'

/** The last answer the box got, kept while the next run is in flight —
 *  the rows stay on screen (dimmed) rather than blinking out per
 *  keystroke. `answered` is what separates "zero matches" from "nothing
 *  has come back yet"; a count of 0 cannot. */
interface StandingAnswer {
  rows: SearchHit[]
  count: number | null
  plus: boolean
  answered: boolean
}

const NO_ANSWER: StandingAnswer = {
  rows: [], count: null, plus: false, answered: false,
}

function lookInLabel(lookIn: QuickLookIn): string {
  if (typeof lookIn === 'object') return lookIn.property
  return FIXED_LOOK_IN.find((o) => o.value === lookIn)?.label ?? 'Everything'
}

export function HeaderSearch() {
  // Destructured, not held as one object: the session carries the input
  // ref, and reading a ref-bearing object's fields through it during
  // render trips the react-hooks lint.
  const {
    quick, setQuick, runNow, clearQuery, clearScope, refine, openPanel,
    inputRef, viewId, resultMatchesQuick, advanced, resolveLayer, layers,
    revealHit, prefetchHit,
  } = useViewSearchSession()
  const scope = quick.scope
  const view = advanced.view

  // The list's own state. All three are the box's, not the session's: a
  // search that is still standing has to survive the list being closed
  // (E-b), and the session must not care whether anything is on screen.
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // The highlighted row, carrying the answer it was chosen IN. A new
  // answer re-ranks the list, so the highlight goes back to the top —
  // and it does so because the hash no longer matches, not because an
  // effect noticed and reset it a render later.
  const [activeAt, setActiveAt] = useState<{ hash: string | null; index: number }>(
    { hash: null, index: 0 },
  )
  // Where a reveal actually landed, when that is not where it was aimed.
  // The producer is the reveal walk itself (E4); the slot, its expiry and
  // its place in the status line are here.
  const [landingNote, setLandingNote] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const { recents, record } = useRecentSearches(`nexus.viewSearch.recent.${viewId}`)

  const trimmed = quick.text.trim()

  // The answer to what is in the box, or null while the standing result
  // belongs to something else. Memoised on the pipeline's own view
  // object so the rows keep their identity between renders — the
  // prefetch timer restarts on a new array, and one that changed per
  // render would never fire.
  const answer = useMemo<StandingAnswer | null>(() => {
    if (view.kind !== 'results' || !resultMatchesQuick) return null
    const result = view.result
    return {
      rows: topMatches(result.hits),
      count: result.totalCount ?? result.candidateCount ?? null,
      // "More than this" is what the plus means, so it belongs only to a
      // count that IS a floor. A truncated run the server still counted
      // exactly has nothing more than its total.
      plus: result.truncated === true && result.totalCount == null,
      answered: true,
    }
  }, [view, resultMatchesQuick])

  // Held across the next run so the rows dim rather than vanish. Emptied
  // when the box is, because then they answer a question nobody is
  // asking any more. Adjusted during render rather than in an effect: an
  // effect would paint one frame of an empty list first.
  const [standing, setStanding] = useState<StandingAnswer>(NO_ANSWER)
  const holds = !trimmed ? NO_ANSWER : (answer ?? standing)
  if (holds !== standing) setStanding(holds)
  const rows = holds.rows

  // `hasContent` is the third of the open rule: an empty box has recents
  // to offer and one character has a hint, but a half-typed word with
  // nothing back yet has nothing to put on screen.
  const hasContent = trimmed === '' || trimmed.length === 1 || hasReportableView(view)
  const open = focused && !dismissed && hasContent

  const resultsHash = view.kind === 'results' ? (advanced.runState?.hash ?? null) : null
  // Closing and re-opening the list does NOT move the highlight — the
  // user left it where they left it (E-b) — so this is keyed on the
  // answer, not on whether anything is on screen.
  const active = activeAt.hash === resultsHash && rows.length > 0
    ? Math.min(activeAt.index, rows.length - 1)
    : 0
  const setActive = useCallback((index: number) => {
    setActiveAt({ hash: resultsHash, index })
  }, [resultsHash])

  // Recents are what was SEARCHED, not what was typed: a query recorded
  // per keystroke would fill the list with five prefixes of one word.
  // A run that found nothing is not worth offering back either.
  const foundCount = view.kind === 'results' ? (view.result.candidateCount ?? 0) : 0
  // Read through a ref, and synced in an effect declared BEFORE the one
  // that reads it: recording has to depend on the RUN, not on the text,
  // or every keystroke after an answer would record a new prefix.
  const textRef = useRef(quick.text)
  useEffect(() => { textRef.current = quick.text })
  useEffect(() => {
    if (resultsHash === null || foundCount <= 0) return
    record(textRef.current)
  }, [resultsHash, foundCount, record])

  useEffect(() => {
    if (!landingNote) return
    const timer = window.setTimeout(() => setLandingNote(null), LANDING_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [landingNote])

  // Warm the spine of the row the user has SETTLED on. Arrowing through
  // a list would otherwise fire ten requests to answer one ↵.
  useEffect(() => {
    if (!open || rows.length === 0) return
    const hit = rows[active]
    if (!hit) return
    const timer = window.setTimeout(() => {
      void prefetchHit(hit.node.urn, hit.ancestorPath ?? [])
    }, PREFETCH_MS)
    return () => window.clearTimeout(timer)
  }, [open, active, rows, prefetchHit])

  // Clicking away closes the list. A click inside the box, inside the
  // list itself (portalled — hence the marker attribute) or inside one of
  // the Look-in/Match popovers (portalled `role="dialog"`) is not away:
  // reading those as "clicked away" put the list down the moment the
  // user went to narrow the search.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (boxRef.current?.contains(target)) return
      if (target.closest?.(`[${DROPDOWN_MARK}]`)) return
      if (target.closest?.('[role="dialog"]')) return
      setDismissed(true)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const pick = useCallback((hit: SearchHit) => {
    void revealHit(hit.node.urn, hit.ancestorPath ?? []).then((outcome) => {
      // Where the walk actually landed, when that is not where it aimed.
      // A hit under a level that would not open is a near-miss, and a
      // near-miss that says nothing reads as a click that did nothing.
      if (outcome.landedOn !== 'ancestor') return
      setLandingNote(outcome.displayName
        ? `Showing ${outcome.displayName} — ${hit.node.displayName} couldn't be opened`
        : `${hit.node.displayName} couldn't be opened`)
    })
    // The text and the canvas highlights stay: the user picked ONE of
    // several matches, and the others are still worth seeing (E-b).
    setDismissed(true)
    record(textRef.current)
  }, [revealHit, record])

  const pickCrumb = useCallback((hit: SearchHit, index: number) => {
    const path = hit.ancestorPath ?? []
    const target = path[index]
    if (!target) return
    // The crumb's OWN ancestors, which is everything before it.
    void revealHit(target.urn, path.slice(0, index))
    setDismissed(true)
  }, [revealHit])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'
      || e.key === 'Home' || e.key === 'End') {
      if (!open || rows.length === 0) return
      e.preventDefault()
      const to = e.key === 'ArrowDown' ? (active + 1) % rows.length
        : e.key === 'ArrowUp' ? (active - 1 + rows.length) % rows.length
          : e.key === 'Home' ? 0
            : rows.length - 1
      setActive(to)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        openPanel()
        setDismissed(true)
        return
      }
      // Only the rows that ANSWER this box can be revealed. Anything
      // else — a failed run, a query still being typed — means "ask
      // again", and after a failure Enter is the only way back.
      if (view.kind === 'results' && resultMatchesQuick && rows.length > 0) {
        pick(rows[active])
      } else {
        runNow()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Two steps (E-f): the list goes first, and the query — with the
      // canvas highlights it published — only if there is no list left
      // to put away.
      if (open) {
        setDismissed(true)
        return
      }
      clearQuery()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Tab') setDismissed(true)
  }, [
    open, rows, active, setActive, view, resultMatchesQuick,
    pick, runNow, openPanel, clearQuery,
  ])

  // Which layer column a hit badges under, by NAME — the row shows the
  // path top-down and the layer is its first term.
  const layerOf = useCallback((hit: SearchHit) => {
    const id = resolveLayer(hit)
    if (!id) return null
    return layers.find((l) => l.id === id)?.name ?? null
  }, [resolveLayer, layers])

  return (
    <div data-tour="canvas-search" className="justify-self-center w-full max-w-xl">
      <div ref={boxRef} className="relative group">
        {/* Accent halo on focus — soft glow behind the field that lifts
            it off the header gradient. Pure decoration; sits behind via
            negative inset. */}
        <div
          aria-hidden
          className={cn(
            "absolute -inset-px rounded-[14px] pointer-events-none",
            "bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0",
            "group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15",
            "group-focus-within:blur-[8px]",
            "transition-all duration-300",
          )}
        />
        {/* A flex shell rather than an input with absolute overlays: the
            right cluster's width changes with the scope chip's label, and
            a fixed padding reservation would either clip the text or
            waste half the field. */}
        <div
          className={cn(
            "relative flex items-center gap-1 pl-3 pr-1.5 rounded-[13px]",
            "bg-gradient-to-b from-black/[0.03] to-black/[0.05]",
            "dark:from-white/[0.04] dark:to-white/[0.025]",
            "border border-black/[0.08] dark:border-white/[0.08]",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
            "hover:border-black/[0.14] dark:hover:border-white/[0.14]",
            "focus-within:border-accent-lineage/55 focus-within:ring-2 focus-within:ring-accent-lineage/20",
            "focus-within:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]",
            "transition-all duration-200",
          )}
        >
          <LucideIcons.Search
            className={cn(
              "shrink-0 w-[15px] h-[15px] pointer-events-none",
              "text-ink-muted/55 group-focus-within:text-accent-lineage",
              "group-hover:text-ink-muted/80",
              "transition-colors duration-200",
            )}
            strokeWidth={2.2}
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search this view…"
            value={quick.text}
            onChange={(e) => {
              // A new word is a new question — whatever the user put the
              // list away for, they are asking again.
              setDismissed(false)
              setQuick({ text: e.target.value })
            }}
            onFocus={() => { setFocused(true); setDismissed(false) }}
            onBlur={(e) => {
              // Only a focus that went somewhere REAL and outside closes
              // the list. Focus landing nowhere (a click on inert chrome)
              // belongs to the mousedown handler above, and the two
              // popovers take focus on purpose while the list stays.
              const next = e.relatedTarget as HTMLElement | null
              if (!next) return
              if (boxRef.current?.contains(next)) return
              if (next.closest?.(`[${DROPDOWN_MARK}]`)) return
              if (next.closest?.('[role="dialog"]')) return
              setFocused(false)
            }}
            onKeyDown={onKeyDown}
            aria-label="Search this view"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && rows.length > 0 ? optionId(listId, active) : undefined
            }
            className={cn(
              "flex-1 min-w-0 bg-transparent border-0 px-2 py-2.5",
              "text-[13.5px] text-ink placeholder:text-ink-muted/45",
              "focus:outline-none",
            )}
          />

          {scope !== 'view' && (
            <span
              className={cn(
                "shrink-0 hidden sm:inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md",
                "text-[10.5px] font-medium text-accent-lineage",
                "bg-accent-lineage/10 border border-accent-lineage/30",
              )}
            >
              <span className="max-w-[90px] truncate">inside {scope.label}</span>
              <button
                type="button"
                onClick={() => clearScope()}
                aria-label="Search the whole view"
                title="Search the whole view"
                className="p-0.5 rounded hover:bg-accent-lineage/20 transition-colors"
              >
                <LucideIcons.X className="w-3 h-3" strokeWidth={2.6} />
              </button>
            </span>
          )}

          <AnchoredMenu
            icon={LucideIcons.ScanSearch}
            current={lookInLabel(quick.lookIn)}
            label="Look in"
            active={quick.lookIn !== 'everything'}
          >
            {(close) => (
              <LookInItems
                viewId={viewId}
                value={quick.lookIn}
                onPick={(lookIn) => { setQuick({ lookIn }); close() }}
              />
            )}
          </AnchoredMenu>

          <AnchoredMenu
            icon={LucideIcons.WholeWord}
            current={MATCH_OPTIONS.find((o) => o.value === quick.match)?.label ?? 'Contains'}
            label="Match"
            active={quick.match !== 'substring'}
          >
            {(close) => (
              <>
                {MATCH_OPTIONS.map((o) => (
                  <MenuItem
                    key={o.value}
                    label={o.label}
                    selected={o.value === quick.match}
                    onPick={() => { setQuick({ match: o.value }); close() }}
                  />
                ))}
              </>
            )}
          </AnchoredMenu>

          <HoverTip label="Refine — build this query out in the results panel">
            <button
              type="button"
              onClick={() => refine()}
              aria-label="Refine this search"
              className={cn(
                'shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg',
                'transition-all duration-200',
                'text-accent-lineage',
                'bg-gradient-to-br from-accent-lineage/15 to-purple-500/10',
                'border border-accent-lineage/30',
                'hover:from-accent-lineage/25 hover:to-purple-500/20',
                'hover:border-accent-lineage/55 hover:shadow-md hover:shadow-accent-lineage/20',
                'active:scale-95',
              )}
            >
              <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          </HoverTip>

          {quick.text && (
            <button
              type="button"
              onClick={() => clearQuery()}
              aria-label="Clear search"
              className={cn(
                "shrink-0 p-1 rounded-md transition-all",
                "text-ink-muted/70 hover:text-ink",
                "hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
              )}
            >
              <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} />
            </button>
          )}
        </div>

        {open && (
          <SearchDropdown
            anchorRef={boxRef}
            listId={listId}
            text={quick.text}
            quick={quick}
            rows={rows}
            activeIndex={active}
            running={view.kind === 'running'}
            error={view.kind === 'error' ? view.message : null}
            zero={holds.answered && rows.length === 0}
            count={holds.count}
            plus={holds.plus}
            recents={recents}
            layerOf={layerOf}
            onActivate={setActive}
            onPick={pick}
            onCrumb={pickCrumb}
            onRecent={(text) => { setQuick({ text }); runNow() }}
            onNarrow={(patch) => setQuick(patch)}
            onSeeAll={() => { openPanel(); setDismissed(true) }}
            onRefine={() => { refine(); setDismissed(true) }}
            onRetry={() => runNow()}
          />
        )}
      </div>
      <StatusLine landingNote={landingNote} />
    </div>
  )
}

/**
 * What the current run has to say, in one line. Silent when idle or
 * failed — the panel owns the error and the zero-result diagnostic; a
 * second copy of either under the box would just be noise.
 *
 * A landing note outranks the count while it stands: "the reveal put you
 * somewhere other than where you aimed" is news, and the count is not.
 */
function StatusLine({ landingNote }: { landingNote: string | null }) {
  const s = useViewSearchSession()
  const view = s.advanced.view

  const line = (() => {
    if (landingNote) return landingNote
    if (view.kind === 'running') return 'Searching…'
    if (view.kind !== 'results') return null
    const result = view.result
    // `totalCount` is the exact size of the candidate set when the server
    // could count it; `candidateCount` is what this page saw.
    const count = result.totalCount ?? result.candidateCount
    const layers = new Set(
      (result.hits ?? [])
        .map((hit) => s.resolveLayer(hit))
        .filter((id): id is string => id !== null),
    )
    // The plus means "more than this", so it belongs only to a count that
    // is a floor — a run the server truncated AND could not count. With
    // an exact total there is nothing more than it, and the count reads
    // singular at one like any other exact number.
    const plus = result.truncated === true && result.totalCount == null
    const matches = count === 1 && !plus ? 'match' : 'matches'
    return `${count.toLocaleString()}${plus ? '+' : ''} ${matches}`
      + ` · ${layers.size} ${layers.size === 1 ? 'layer' : 'layers'}`
  })()

  if (!line) return null

  return (
    <div className="mt-1.5 px-1 text-[10.5px] leading-none text-ink-muted/65 truncate">
      {line}
    </div>
  )
}


/** The property keys this view can be searched by, alongside the four
 *  fixed fields. Mounted only while the menu is open, so the discover
 *  request is the cost of opening it. */
function LookInItems({ viewId, value, onPick }: {
  viewId: string
  value: QuickLookIn
  onPick: (lookIn: QuickLookIn) => void
}) {
  const { allKeys } = useDiscovery(viewId)

  return (
    <>
      {FIXED_LOOK_IN.map((o) => (
        <MenuItem
          key={String(o.value)}
          label={o.label}
          selected={o.value === value}
          onPick={() => onPick(o.value)}
        />
      ))}
      {allKeys.length > 0 && (
        <div className="mt-1 pt-1 px-2.5 pb-0.5 border-t border-black/[0.06] dark:border-white/[0.06] text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">
          Properties
        </div>
      )}
      {allKeys.map((key) => (
        <MenuItem
          key={`prop:${key}`}
          label={key}
          selected={typeof value === 'object' && value.property === key}
          onPick={() => onPick({ property: key })}
        />
      ))}
    </>
  )
}

function MenuItem({ label, selected, onPick }: {
  label: string
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left',
        'text-[12px] transition-colors',
        selected
          ? 'text-accent-lineage bg-accent-lineage/10'
          : 'text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
      )}
    >
      <LucideIcons.Check
        className={cn('w-3 h-3 shrink-0', !selected && 'opacity-0')}
        strokeWidth={2.6}
      />
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * An icon trigger and the list it anchors, portalled to the body.
 *
 * The header creates a stacking context (it has a backdrop-filter), so a
 * list rendered inline would be layered under the canvas. No
 * AnimatePresence: the list unmounts instantly on close so an interrupted
 * exit can never strand an invisible click-blocker over the toolbar.
 *
 * `role="dialog"` over plain buttons, the way `DisplayMenu` does it —
 * NOT `menu`/`menuitem`, which promise arrow-key navigation and a roving
 * tabindex this does not implement. Focus moves to the first row on open
 * (the list is portalled to the end of `document.body`, so otherwise a
 * keyboard user reaches it only by tabbing past the whole app) and goes
 * back to the trigger when it closes, so it is never simply dropped.
 *
 * The trigger is a bare icon — a `HoverTip` carries the "{label}: {current}"
 * text a visible chip used to show, and a small accent dot marks it when
 * `current` has moved off the default so the setting isn't invisible when
 * closed.
 */
function AnchoredMenu({ icon: Icon, current, label, active, children }: {
  icon: LucideIcon
  current: string
  label: 'Look in' | 'Match'
  active: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ top: rect.bottom + 6, left: rect.left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const close = useCallback(() => { setOpen(false) }, [])

  // Whether this popover currently owns the page's focus. It decides who
  // gets focus back when the popover closes, and it is the reason the two
  // effects below can be the only places that touch a ref.
  const holdsFocusRef = useRef(false)

  // Focus the first row once per opening. `anchor` is measured in a layout
  // effect, so the list is not yet in the DOM on the render that flips
  // `open`; the flag also keeps a later anchor update (resize, scroll)
  // from stealing focus back from wherever the user has since moved it.
  useEffect(() => {
    if (!open || holdsFocusRef.current) return
    const first = listRef.current?.querySelector('button')
    if (!first) return
    holdsFocusRef.current = true
    first.focus()
  }, [open, anchor])

  // Closing while still holding focus — Escape, a chosen row, a click on
  // inert chrome — would otherwise drop it on <body>, and the list is
  // portalled to the end of the document, so there is nothing sensible
  // after it to tab to. A click on another control cleared the flag
  // already: the user went there on purpose.
  useEffect(() => {
    if (open || !holdsFocusRef.current) return
    holdsFocusRef.current = false
    triggerRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (triggerRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      // Clicking a control means going there — taking focus back would
      // fight the user. Clicking inert chrome leaves focus nowhere, so
      // the trigger keeps its claim on it.
      if (target.closest?.(FOCUSABLE)) holdsFocusRef.current = false
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  return (
    <>
      <HoverTip label={`${label}: ${current}`}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => { if (open) close(); else setOpen(true) }}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}: ${current}`}
          className={cn(
            'relative shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md',
            'transition-colors',
            open
              ? 'text-ink bg-black/[0.07] dark:bg-white/[0.09]'
              : 'text-ink-muted/80 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
          )}
        >
          <Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
          {active && (
            <span
              aria-hidden
              data-testid="narrowed-dot"
              className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-accent-lineage"
            />
          )}
        </button>
      </HoverTip>

      {typeof document !== 'undefined' && createPortal(
        <>
          {open && anchor && (
            <motion.div
              ref={listRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.13, ease: 'easeOut' }}
              role="dialog"
              aria-label={label}
              style={{
                position: 'fixed',
                top: anchor.top,
                left: anchor.left,
                zIndex: 1000,
                maxHeight: `calc(100vh - ${anchor.top}px - 16px)`,
              }}
              className="min-w-[180px] overflow-y-auto custom-scrollbar p-1 rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40"
            >
              <div className="pt-0.5 px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted/60">
                {label} · {current}
              </div>
              {children(close)}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}
