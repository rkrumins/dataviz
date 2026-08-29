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
 * "Look in" and "Match" are two anchored lists built the way
 * `DisplayMenu` builds its popover (portal + framer-motion, no
 * AnimatePresence — an interrupted exit strands an invisible
 * click-blocker). The property keys under "Look in" are fetched when that
 * menu opens, not on every canvas render: `/search/discover` is a real
 * request, and a menu nobody opened should not pay for one.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDiscovery } from '../../search/builder/useDiscovery'
import { TEXT_MATCH_OPTIONS } from '../../search/panel/ConditionRow'
import type { QuickLookIn, QuickMatch } from '../../search/session/quickPredicate'
import { useViewSearchSession } from '../../search/session/ViewSearchSessionContext'

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

function lookInLabel(lookIn: QuickLookIn): string {
  if (typeof lookIn === 'object') return lookIn.property
  return FIXED_LOOK_IN.find((o) => o.value === lookIn)?.label ?? 'Everything'
}

export function HeaderSearch() {
  // Destructured, not held as one object: the session carries the input
  // ref, and reading a ref-bearing object's fields through it during
  // render trips the react-hooks lint.
  const {
    quick, setQuick, runNow, clearQuery, clearScope, refine, inputRef, viewId,
  } = useViewSearchSession()
  const scope = quick.scope

  return (
    <div data-tour="canvas-search" className="justify-self-center w-full max-w-md">
      <div className="relative group">
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
            placeholder="Search this view — names, descriptions, properties…"
            value={quick.text}
            onChange={(e) => setQuick({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                runNow()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                clearQuery()
                e.currentTarget.blur()
              }
            }}
            aria-label="Search this view"
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

          <AnchoredMenu label={lookInLabel(quick.lookIn)} ariaLabel="Look in">
            {(close) => (
              <LookInItems
                viewId={viewId}
                value={quick.lookIn}
                onPick={(lookIn) => { setQuick({ lookIn }); close() }}
              />
            )}
          </AnchoredMenu>

          <AnchoredMenu
            label={MATCH_OPTIONS.find((o) => o.value === quick.match)?.label ?? 'Contains'}
            ariaLabel="Match"
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

          <button
            type="button"
            onClick={() => refine()}
            aria-label="Refine this search"
            title="Refine — build this query out in the results panel"
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
      </div>
      <StatusLine />
    </div>
  )
}

/**
 * What the current run has to say, in one line. Silent when idle or
 * failed — the panel owns the error and the zero-result diagnostic; a
 * second copy of either under the box would just be noise.
 */
function StatusLine() {
  const s = useViewSearchSession()
  const view = s.advanced.view

  const line = (() => {
    if (view.kind === 'running') return 'Searching…'
    if (view.kind !== 'results') return null
    const result = view.result
    // `totalCount` is the exact size of the candidate set when the server
    // could count it; `candidateCount` is what this page saw. Read
    // defensively — the generated types trail the server.
    const count = (result as { totalCount?: number | null }).totalCount
      ?? result.candidateCount
    const layers = new Set(
      (result.hits ?? [])
        .map((hit) => s.resolveLayer(hit))
        .filter((id): id is string => id !== null),
    )
    return `${count.toLocaleString()}${result.truncated ? '+' : ''} matches · ${layers.size} layers`
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
      role="menuitem"
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
 * A label ▾ trigger and the list it anchors, portalled to the body.
 *
 * The header creates a stacking context (it has a backdrop-filter), so a
 * list rendered inline would be layered under the canvas. No
 * AnimatePresence: the list unmounts instantly on close so an interrupted
 * exit can never strand an invisible click-blocker over the toolbar.
 */
function AnchoredMenu({ label, ariaLabel, children }: {
  label: string
  ariaLabel: string
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

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${ariaLabel} · ${label}`}
        className={cn(
          'shrink-0 hidden sm:inline-flex items-center gap-0.5 pl-1.5 pr-1 py-1 rounded-md',
          'text-[10.5px] font-medium max-w-[92px]',
          'transition-colors',
          open
            ? 'text-ink bg-black/[0.07] dark:bg-white/[0.09]'
            : 'text-ink-muted/80 hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
        )}
      >
        <span className="truncate">{label}</span>
        <LucideIcons.ChevronDown
          className={cn('w-3 h-3 shrink-0 transition-transform duration-200', open && 'rotate-180')}
          strokeWidth={2.4}
        />
      </button>

      {typeof document !== 'undefined' && createPortal(
        <>
          {open && anchor && (
            <motion.div
              ref={listRef}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.13, ease: 'easeOut' }}
              role="menu"
              aria-label={ariaLabel}
              style={{
                position: 'fixed',
                top: anchor.top,
                left: anchor.left,
                zIndex: 1000,
                maxHeight: `calc(100vh - ${anchor.top}px - 16px)`,
              }}
              className="min-w-[180px] overflow-y-auto custom-scrollbar p-1 rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40"
            >
              {children(() => setOpen(false))}
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}
