/**
 * Saved filters — a person's own quick filters, beside the built-in ones.
 *
 * Building "versioned finance views Ada changed this month" takes four menus; doing
 * it again tomorrow should take one click. A pill applies its filter set (and the
 * sort, when one was chosen), and lights up whenever the filters on screen are
 * that set, however they got there. They live on the server, so they follow the
 * person to any browser.
 *
 * Save names the filter from what it filters ("Versioned · Updated past 7 days ·
 * By Ada Lovelace") so saving is one click; the name can be changed before or
 * after. Each pill's ⋯ menu renames it, points it at the current filters, copies a
 * link, moves it, or deletes it — with an Undo, because a pill is quicker to lose
 * than to rebuild.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, ChevronLeft, ChevronRight, Link2, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { useAppNotifications } from '@/components/ui/notifications'
import type { SavedViewFilter } from '@/services/savedViewFiltersService'
import { activeDimensions, suggestFilterName, type FilterLookups } from '../dimensions'
import { isAnyFilterActive, type ViewFilterState } from '../model'
import { canonicalFilterQuery, matchesFilterQuery } from '../url'
import { useSavedViewFilters } from '../useSavedViewFilters'

/** Pills shown in the row; the rest wait under "+N". */
const VISIBLE = 5

const MENU_W = 224
const POPOVER_W = 320

/** Whether a panel this wide, opened under `el`, would run off the right edge —
 *  then it opens leftward from the control's right edge instead. */
function opensLeftward(el: Element, width: number): boolean {
  return el.getBoundingClientRect().left + width > window.innerWidth - 16
}

/** Close on a click outside `ref` or on Escape, while `open`. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref, close])
}

export function SavedFilterPills({ state, sort, lookups, onApply }: {
  state: ViewFilterState
  /** The order on screen when it isn't the default; saved along with the filters. */
  sort: string | null
  lookups: FilterLookups
  /** Put a saved query on screen: its filters, and its sort if it has one. */
  onApply: (query: string) => void
}) {
  const { filters, create, update, remove, reorder } = useSavedViewFilters()
  const { notify } = useAppNotifications()
  const [naming, setNaming] = useState<
    { mode: 'save'; leftward: boolean } | { mode: 'rename'; filter: SavedViewFilter; leftward: boolean } | null
  >(null)
  const [menuFor, setMenuFor] = useState<{ id: string; leftward: boolean } | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)

  const anyActive = isAnyFilterActive(state)
  const activeId = filters.find(f => matchesFilterQuery(f.query, state))?.id ?? null
  if (filters.length === 0 && !anyActive) return null

  const queryNow = () => canonicalFilterQuery(state, { sort })
  const visible = filters.slice(0, VISIBLE)
  const hidden = filters.slice(VISIBLE)

  const move = (id: string, by: -1 | 1) => {
    const ids = filters.map(f => f.id)
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    reorder.mutate(ids)
  }

  const del = (f: SavedViewFilter) => {
    const order = filters.map(x => x.id)
    remove.mutate(f.id)
    notify('info', `Deleted "${f.name}"`, {
      label: 'Undo',
      // Back under its old name, in its old place.
      onClick: () => create.mutate({ name: f.name, query: f.query }, {
        onSuccess: restored => reorder.mutate(order.map(id => (id === f.id ? restored.id : id))),
      }),
    })
  }

  const copyLink = async (f: SavedViewFilter) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/explorer?${f.query}`)
      notify('success', 'Link copied')
    } catch {
      notify('error', "Couldn't copy the link")
    }
  }

  const pill = (f: SavedViewFilter, inOverflow = false) => {
    const active = f.id === activeId
    return (
      <div
        key={f.id}
        className={cn(
          'group/pill relative flex items-center rounded-lg text-xs font-medium transition-colors duration-150',
          inOverflow ? 'w-full' : '',
          active
            ? 'bg-accent-lineage/10 text-accent-lineage'
            : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
        )}
      >
        <button
          type="button"
          aria-pressed={active}
          onClick={() => { onApply(f.query); setOverflowOpen(false) }}
          title={f.name}
          className={cn('flex min-w-0 items-center gap-1.5 py-1.5 pl-3 pr-1', inOverflow && 'flex-1')}
        >
          <Bookmark className="h-3.5 w-3.5 shrink-0" fill={active ? 'currentColor' : 'none'} />
          <span className={cn('truncate', inOverflow ? 'max-w-none' : 'max-w-[11rem]')}>{f.name}</span>
        </button>
        <button
          type="button"
          aria-label={`More for ${f.name}`}
          aria-haspopup="menu"
          aria-expanded={menuFor?.id === f.id}
          onClick={e => {
            const leftward = opensLeftward(e.currentTarget, MENU_W)
            setMenuFor(m => (m?.id === f.id ? null : { id: f.id, leftward }))
          }}
          className={cn(
            'mr-1 rounded p-0.5 transition-opacity duration-150 focus-visible:opacity-100',
            menuFor?.id === f.id || active ? 'opacity-100' : 'opacity-0 group-hover/pill:opacity-100',
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menuFor?.id === f.id && (
          <PillMenu
            leftward={menuFor.leftward}
            filter={f}
            index={filters.indexOf(f)}
            count={filters.length}
            canUpdate={anyActive && !matchesFilterQuery(f.query, state)}
            onClose={() => setMenuFor(null)}
            onRename={() => setNaming({ mode: 'rename', filter: f, leftward: menuFor.leftward })}
            onUpdate={() => update.mutate({ id: f.id, query: queryNow() }, {
              onSuccess: () => notify('success', `"${f.name}" now saves these filters`),
            })}
            onCopy={() => void copyLink(f)}
            onMove={by => move(f.id, by)}
            onDelete={() => del(f)}
          />
        )}
        {naming?.mode === 'rename' && naming.filter.id === f.id && (
          <NamePopover
            leftward={naming.leftward}
            title="Rename"
            initial={f.name}
            submitLabel="Rename"
            pending={update.isPending}
            onCancel={() => { setNaming(null); update.reset() }}
            error={update.error instanceof Error ? update.error.message : null}
            onSubmit={name => update.mutate({ id: f.id, name }, { onSuccess: () => setNaming(null) })}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <span aria-hidden className="mx-1 h-4 w-px bg-black/[0.08] dark:bg-white/[0.1]" />
      {visible.map(f => pill(f))}
      {hidden.length > 0 && (
        <Overflow open={overflowOpen} onOpenChange={setOverflowOpen} count={hidden.length}>
          {hidden.map(f => pill(f, true))}
        </Overflow>
      )}
      {anyActive && !activeId && (
        <div className="relative">
          <button
            type="button"
            onClick={e => setNaming({ mode: 'save', leftward: opensLeftward(e.currentTarget, POPOVER_W) })}
            aria-haspopup="dialog"
            aria-expanded={naming?.mode === 'save'}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/5 transition-colors duration-150"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            Save
          </button>
          {naming?.mode === 'save' && (
            <NamePopover
              leftward={naming.leftward}
              title="Save these filters"
              initial={suggestFilterName(state, lookups)}
              summary={activeDimensions(state).map(d => d.summary(state, lookups))}
              submitLabel="Save"
              pending={create.isPending}
              onCancel={() => { setNaming(null); create.reset() }}
              error={create.error instanceof Error ? create.error.message : null}
              onSubmit={name => create.mutate({ name, query: queryNow() }, {
                onSuccess: () => setNaming(null),
              })}
            />
          )}
        </div>
      )}
    </>
  )
}

function Overflow({ open, onOpenChange, count, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, () => onOpenChange(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="rounded-lg px-2 py-1.5 text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors duration-150"
      >
        +{count}
      </button>
      {open && (
        <div
          {...keyboardScopeProps('view-filters')}
          className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-glass-border bg-canvas p-1 shadow-xl"
        >
          {children}
        </div>
      )}
    </div>
  )
}

function PillMenu({ leftward, filter, index, count, canUpdate, onClose, onRename, onUpdate, onCopy, onMove, onDelete }: {
  leftward: boolean
  filter: SavedViewFilter
  index: number
  count: number
  canUpdate: boolean
  onClose: () => void
  onRename: () => void
  onUpdate: () => void
  onCopy: () => void
  onMove: (by: -1 | 1) => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(true, ref, onClose)
  const item = (label: string, Icon: React.ComponentType<{ className?: string }>, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => { run(); onClose() }}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-150',
        danger ? 'text-red-600 dark:text-red-400 hover:bg-red-500/10' : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  )
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={filter.name}
      {...keyboardScopeProps('view-filters')}
      style={{ width: MENU_W }}
      className={cn(
        'absolute top-full z-50 mt-1.5 rounded-xl border border-glass-border bg-canvas p-1 shadow-xl',
        leftward ? 'right-0' : 'left-0',
      )}
    >
      {item('Rename…', Pencil, onRename)}
      {canUpdate && item('Save the current filters here', RefreshCw, onUpdate)}
      {item('Copy link', Link2, onCopy)}
      {index > 0 && item('Move left', ChevronLeft, () => onMove(-1))}
      {index < count - 1 && item('Move right', ChevronRight, () => onMove(1))}
      <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.08]" />
      {item('Delete', Trash2, onDelete, true)}
    </div>
  )
}

function NamePopover({ leftward, title, initial, summary, submitLabel, pending, error, onSubmit, onCancel }: {
  leftward: boolean
  title: string
  initial: string
  /** What the filter will hold, one dimension per line. */
  summary?: string[]
  submitLabel: string
  pending: boolean
  error: string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const ref = useRef<HTMLFormElement>(null)
  const inputId = useId()
  const errorId = useId()
  useDismiss(true, ref, onCancel)
  const trimmed = name.trim()
  return (
    <form
      ref={ref}
      role="dialog"
      aria-label={title}
      {...keyboardScopeProps('view-filters')}
      onSubmit={e => { e.preventDefault(); if (trimmed && !pending) onSubmit(trimmed) }}
      style={{ width: POPOVER_W }}
      className={cn(
        'absolute top-full z-50 mt-1.5 max-w-[calc(100vw-2rem)] rounded-xl border border-glass-border bg-canvas p-3 shadow-xl',
        leftward ? 'right-0' : 'left-0',
      )}
    >
      <label htmlFor={inputId} className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">{title}</label>
      <input
        id={inputId}
        autoFocus
        value={name}
        maxLength={80}
        onChange={e => setName(e.target.value)}
        // Selected, to type over in one go, but from the end so the start of a
        // long name is what shows.
        onFocus={e => e.currentTarget.setSelectionRange(0, e.currentTarget.value.length, 'backward')}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className="mt-1.5 w-full rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-1.5 text-sm text-ink outline-none focus:ring-2 focus:ring-accent-lineage/40"
      />
      {error && <p id={errorId} role="alert" className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      {summary && summary.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
          {summary.map(line => <li key={line} className="truncate">{line}</li>)}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!trimmed || pending}
          className="rounded-lg bg-accent-lineage px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 transition-opacity"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
