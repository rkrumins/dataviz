/**
 * ExplorerSearchBox — the Explorer's search, which also takes filters typed as text.
 *
 * Free words search names, descriptions and tags as before. A token —
 * `by:ada`, `is:versioned`, `updated:<30d`, `tag:pii` — becomes the very filter
 * its menu would set (and the same chip) as soon as it is finished with a space,
 * Enter or Tab, so someone who knows what they want never has to open a menu.
 * While a token is being typed, the panel under the box offers its values with
 * their live counts; with the box empty it shows recent searches and a few
 * examples. A token that names nothing stays as text with a hint, rather than
 * becoming a filter that silently matches nothing.
 *
 * The typewriter placeholder keeps its performance contract: the hook writes
 * straight to two refs and never re-renders the page.
 */
import { useId, useMemo, useState } from 'react'
import { Clock, History, Search, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTypewriter } from '@/hooks/useTypewriter'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { ME, type ViewFilterState } from '@/features/view-filters/model'
import type { ResolveContext } from '@/features/view-filters/params'
import type { CurrentPerson } from '@/features/view-filters/people'
import { useLiveFacets } from '@/features/view-filters/useLiveFacets'
import { useTokenResolver } from '@/features/view-filters/useTokenResolver'
import {
  DATE_TOKEN_CHOICES, IS_CATEGORY_VALUES, IS_CHOICES, TOKEN_EXAMPLES, applyTokens, insertToken, parseTokens,
  tokenAtCaret, type ParsedToken, type TokenKey,
} from '@/features/view-filters/tokens'

interface Suggestion {
  id: string
  /** What goes after `key:`. */
  insert: string
  label: string
  detail?: string
  count?: number
  /** A person row shows their avatar. */
  personId?: string | null
  avatarId?: string | null
}

const GROUP_TITLE: Record<TokenKey, string> = {
  by: 'Created or edited by', 'created-by': 'Created by', 'edited-by': 'Edited by',
  'published-by': 'Data published by', is: 'Kind of view', type: 'Type', tag: 'Tags',
  ws: 'Workspaces', source: 'Sources', vis: 'Visibility', created: 'Created', updated: 'Updated',
}

const IS_LABELS: Record<string, string> = {
  versioned: 'Versioned graphs', external: 'External graphs', private: 'Private',
  workspace: 'Workspace visibility', enterprise: 'Enterprise visibility', mine: 'My views',
  fav: 'Favorites', favorite: 'Favorites', favourite: 'Favorites', shared: 'Shared with me',
  attention: 'Need attention', deleted: 'Deleted', recent: 'Recently added',
}

const MAX_SUGGESTIONS = 8

/* Typewriter caret: hard on/off blink using steps(), so the cursor
   feels like a proper terminal cursor rather than a smeared fade. */
const TYPEWRITER_STYLE = `
@keyframes typewriter-caret-blink {
  0%, 49.99% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.typewriter-caret-blink {
  animation: typewriter-caret-blink 1.05s steps(1, end) infinite;
}
`

export function ExplorerSearchBox({
  value, onChange, onCommit, inputRef, state, onApplyFilters, ctx, currentUser,
  recents = [], onClearRecents, onRemoveRecent, onRemoveLastFilter, fixedWorkspace, className = 'mb-5',
}: {
  value: string
  onChange: (text: string) => void
  /** Enter: search now rather than after the debounce. */
  onCommit?: (text: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  state: ViewFilterState
  /** Given a change, not a whole state, so a second token typed before the
   *  host has re-rendered builds on the first instead of replacing it. */
  onApplyFilters: (update: (prev: ViewFilterState) => ViewFilterState) => void
  /** The host's resolve context, so the counts here match its list. */
  ctx: ResolveContext
  currentUser: CurrentPerson | null
  recents?: string[]
  onClearRecents?: () => void
  onRemoveRecent?: (q: string) => void
  /** Backspace in an empty box: take off the last filter chip. */
  onRemoveLastFilter?: () => void
  /** A surface fixed to one workspace (its Views tab): `ws:` names nothing
   *  there, and an `is:` category would set a filter it has no pill to show,
   *  so both stay as text with a hint. */
  fixedWorkspace?: boolean
  className?: string
}) {
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [unresolved, setUnresolved] = useState<ParsedToken[]>([])
  const listId = useId()

  const placeholderPhrases = useMemo(() => [
    'views by name, tag, or workspace…',
    'by:me — the views you made or edited…',
    'is:versioned or is:external…',
    'updated:<7d — what changed this week…',
    'a tag — "finance", "pii", "kpi"…',
  ], [])
  const { textRef: typewriterText, caretRef: typewriterCaret } = useTypewriter({
    phrases: placeholderPhrases, enabled: !focused && !value,
  })

  const today = ctx.today
  const { universe, people, counts } = useLiveFacets(state, ctx)
  const { resolver, candidates } = useTokenResolver(universe, people)

  const active = tokenAtCaret(value, caret)
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!active) return []
    const q = active.partial.toLowerCase()
    const hit = (...texts: (string | null | undefined)[]) => !q || texts.some(t => t?.toLowerCase().includes(q))
    const named = (rows: { id: string; name: string }[], countOf?: (id: string) => number | undefined) =>
      rows.filter(r => hit(r.name)).map(r => ({ id: r.id, insert: r.name, label: r.name, count: countOf?.(r.id) }))
    switch (active.key) {
      case 'by': case 'created-by': case 'edited-by': case 'published-by': {
        const countFor = (p: typeof people[number]) => (
          active.key === 'created-by' ? p.createdCount : active.key === 'edited-by' ? p.editedCount
            : active.key === 'published-by' ? p.publishedCount : p.count)
        const me = currentUser ? people.find(p => p.userId === currentUser.id) : undefined
        const you: Suggestion[] = currentUser && hit('me', 'you', currentUser.name, currentUser.email)
          ? [{ id: ME, insert: 'me', label: 'You', detail: currentUser.name, count: me ? countFor(me) : undefined, personId: currentUser.id, avatarId: currentUser.avatarId }]
          : []
        return [...you, ...people
          .filter(p => p.userId !== currentUser?.id && hit(p.displayName, p.email))
          .map(p => ({ id: p.userId, insert: p.displayName, label: p.displayName, detail: p.email ?? undefined, count: countFor(p), personId: p.userId, avatarId: p.avatarId }))]
      }
      case 'is':
        return IS_CHOICES.filter(c => !['favorite', 'favourite'].includes(c) && hit(c, IS_LABELS[c]))
          .filter(c => !fixedWorkspace || !IS_CATEGORY_VALUES.has(c))
          .map(c => ({ id: c, insert: c, label: c, detail: IS_LABELS[c] }))
      case 'type': return named(candidates.viewTypes, id => counts.viewTypes?.get(id))
      case 'tag': return named(candidates.tags, id => counts.tags?.get(id))
      case 'ws': return fixedWorkspace ? [] : named(candidates.workspaces, id => counts.workspaces?.get(id))
      case 'source': return named(candidates.dataSources, id => counts.dataSources?.get(id))
      case 'vis':
        return ['private', 'workspace', 'enterprise'].filter(v => hit(v))
          .map(v => ({ id: v, insert: v, label: v, count: counts.visibilities?.get(v) }))
      case 'created': case 'updated':
        return DATE_TOKEN_CHOICES.filter(c => hit(c.value, c.label))
          .map(c => ({ id: c.value, insert: c.value, label: c.value, detail: c.label }))
    }
  }, [active, people, currentUser, candidates, counts, fixedWorkspace]).slice(0, MAX_SUGGESTIONS)

  /**
   * Turn every finished token in `text` into its filter; keep the rest as search
   * text. A token that names nothing stays in the text, flagged.
   */
  const convert = (text: string): string => {
    const { tokens, text: rest } = parseTokens(text)
    if (tokens.length === 0) return text
    const fits = (t: ParsedToken) =>
      !fixedWorkspace || (t.key !== 'ws' && !(t.key === 'is' && IS_CATEGORY_VALUES.has(t.value.toLowerCase())))
    const usable = tokens.filter(fits)
    // Whether a token names anything doesn't depend on the filters, so the
    // current ones are enough to find what stays text.
    const result = applyTokens(state, usable, resolver, today)
    if (result.unresolved.length < usable.length) {
      onApplyFilters(prev => applyTokens(prev, usable, resolver, today).state)
    }
    const unresolvedNow = [...tokens.filter(t => !fits(t)), ...result.unresolved]
    setUnresolved(unresolvedNow)
    const kept = [rest, ...unresolvedNow.map(t => t.raw)].filter(Boolean).join(' ')
    return kept ? `${kept} ` : ''
  }

  const update = (text: string, nextCaret: number) => {
    setDismissed(false)
    setHighlight(0)
    // A finished token — followed by a space — becomes its filter.
    if (/\s$/.test(text) && parseTokens(text).tokens.length > 0) {
      const next = convert(text)
      onChange(next)
      setCaret(next.length)
      return
    }
    onChange(text)
    setCaret(nextCaret)
  }

  const pick = (s: Suggestion) => {
    if (!active) return
    const next = convert(insertToken(value, active, active.key, s.insert))
    onChange(next)
    setCaret(next.length)
    setHighlight(0)
    inputRef.current?.focus()
  }

  const open = focused && !dismissed
  const showSuggestions = open && suggestions.length > 0
  const showIdle = open && !value && !active
  const activeOptionId = showSuggestions ? `${listId}-opt-${highlight}` : undefined

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const n = suggestions.length
      setHighlight(h => (e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n))
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && showSuggestions) {
      e.preventDefault()
      pick(suggestions[Math.min(highlight, suggestions.length - 1)])
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const next = parseTokens(value).tokens.length ? convert(value) : value
      onChange(next)
      onCommit?.(next.trim())
      return
    }
    if (e.key === 'Backspace' && !value && onRemoveLastFilter) {
      e.preventDefault()
      onRemoveLastFilter()
      return
    }
    if (e.key === 'Escape' && (showSuggestions || showIdle)) {
      // First Escape closes the panel; the page's own Escape (clear the
      // search) is the second.
      e.stopPropagation()
      e.nativeEvent.stopImmediatePropagation()
      setDismissed(true)
    }
  }

  return (
    <div data-tour="explorer-search" className={cn('relative', className)}>
      <style>{TYPEWRITER_STYLE}</style>
      <div className={cn(
        'relative flex items-center rounded-xl border bg-canvas-elevated overflow-hidden',
        'transition-[border-color,box-shadow] duration-200',
        focused
          ? 'border-accent-lineage/50 shadow-[0_0_0_3px_rgba(var(--accent-lineage-rgb,99,102,241),0.08)]'
          : 'border-glass-border',
      )}>
        <Search className={cn(
          'w-4.5 h-4.5 ml-4 shrink-0 transition-colors duration-150',
          focused ? 'text-accent-lineage' : 'text-ink-muted',
        )} />
        {/* Input wrapper — lets the typewriter overlay sit atop the input
            without blocking pointer events. */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search views, or type a filter such as by:me or is:versioned"
            aria-autocomplete="list"
            aria-expanded={showSuggestions}
            aria-controls={listId}
            aria-activedescendant={activeOptionId}
            /* Fallback for no-JS / reduced-motion: a static prompt. */
            placeholder={(!focused && !value) ? '' : 'Search, or type by:, is:, updated:, tag:…'}
            value={value}
            onChange={e => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onSelect={e => setCaret((e.target as HTMLInputElement).selectionStart ?? value.length)}
            onKeyDown={onKeyDown}
            onFocus={() => { setFocused(true); setDismissed(false) }}
            onBlur={() => setFocused(false)}
            className="w-full bg-transparent py-2.5 px-3 text-sm text-ink outline-none placeholder:text-ink-muted font-medium"
          />
          {!focused && !value && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 px-3 py-2.5 flex items-center text-sm font-medium text-ink-muted overflow-hidden whitespace-nowrap"
            >
              <span>Search </span>
              {/* The animated text and the caret's blink are driven by the
                  hook writing DIRECTLY to these refs — it holds no React
                  state, so this ticking animation re-renders NOTHING. See
                  useTypewriter's performance contract: driving it through
                  state re-rendered the whole page (and every result card)
                  ~30x/sec forever, which in React 19 dev leaked millions of
                  PerformanceMeasure objects into an uncapped timeline. */}
              <span ref={typewriterText} className="ml-1" />
              <span
                ref={typewriterCaret}
                className="ml-[2px] inline-block w-[2px] h-[1.1em] translate-y-[1px] bg-accent-lineage/70 rounded-[1px] typewriter-caret-blink"
              />
            </div>
          )}
        </div>
        {value && (
          <button
            onClick={() => { onChange(''); setUnresolved([]) }}
            title="Clear search"
            aria-label="Clear search"
            className="mr-1.5 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors duration-150"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <kbd className="hidden sm:block mr-3 rounded border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
          /
        </kbd>
      </div>

      {unresolved.length > 0 && (
        <p className="mt-1.5 px-1 text-[11px] text-amber-700 dark:text-amber-300" role="status">
          {unresolved.map(t => t.raw).join(', ')} {unresolved.length === 1 ? "doesn't" : "don't"} match anything you can see
          {' '}— finish it from the suggestions, or remove it.
        </p>
      )}

      {(showSuggestions || showIdle) && (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-2 rounded-xl border border-black/[0.08] dark:border-white/[0.1] bg-canvas-elevated p-2 text-xs shadow-xl"
          // Clicks in the panel must not blur the input before they land.
          onMouseDown={e => e.preventDefault()}
        >
          {showSuggestions && active && (
            <>
              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                {GROUP_TITLE[active.key]}
              </div>
              <ul role="listbox" id={listId} aria-label={GROUP_TITLE[active.key]}>
                {suggestions.map((s, i) => (
                  <li
                    key={s.id}
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => pick(s)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5',
                      i === highlight ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                      s.count === 0 && i !== highlight && 'opacity-50',
                    )}
                  >
                    {s.personId !== undefined ? (
                      <UserAvatar userId={s.personId} name={s.label === 'You' ? (s.detail ?? 'You') : s.label} avatarId={s.avatarId} shape="palette" className="h-6 w-6 text-[9px] font-bold" />
                    ) : (
                      <span className="rounded bg-black/[0.05] dark:bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                        {active.key}:
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink">{s.label}</span>
                      {s.detail && <span className="ml-1.5 text-ink-muted">{s.detail}</span>}
                    </span>
                    {s.count !== undefined && (
                      <span className="tabular-nums text-[10px] font-semibold text-ink-muted">{s.count.toLocaleString()}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-1 border-t border-black/[0.06] dark:border-white/[0.08] px-2 pt-1.5 text-[10px] text-ink-muted">
                <kbd className="kbd">↑↓</kbd> choose · <kbd className="kbd">↵</kbd> or <kbd className="kbd">Tab</kbd> add as a filter · <kbd className="kbd">Esc</kbd> close
              </div>
            </>
          )}

          {showIdle && (
            <>
              {recents.length > 0 && (
                <>
                  <div className="flex items-center justify-between px-2 py-1">
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-ink-muted">
                      <History className="h-3 w-3" />
                      Recent searches
                    </div>
                    <button type="button" onClick={() => onClearRecents?.()} className="text-[10px] text-ink-muted hover:text-ink transition-colors">
                      Clear
                    </button>
                  </div>
                  {recents.map(q => (
                    <div key={q} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]">
                      <Clock className="h-3 w-3 text-ink-muted shrink-0" />
                      <button
                        type="button"
                        onClick={() => { const next = convert(`${q} `).trim(); onChange(next); onCommit?.(next) }}
                        className="flex-1 text-left truncate font-medium"
                      >
                        {q}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveRecent?.(q)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-opacity"
                        aria-label={`Remove ${q} from recent searches`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </>
              )}
              <div className={cn('flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-ink-muted', recents.length > 0 && 'mt-1')}>
                <Sparkles className="h-3 w-3" />
                Type a filter
              </div>
              <div className="flex flex-wrap gap-1.5 px-2 pb-1">
                {TOKEN_EXAMPLES.map(ex => (
                  <button
                    key={ex.token}
                    type="button"
                    onClick={() => {
                      // A complete example applies at once; `tag:` waits for a value.
                      if (ex.token.endsWith(':')) {
                        onChange(ex.token)
                        setCaret(ex.token.length)
                      } else {
                        const next = convert(`${ex.token} `)
                        onChange(next)
                        setCaret(next.length)
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] dark:border-white/[0.1] px-2 py-1 hover:border-accent-lineage/40 hover:bg-accent-lineage/5 transition-colors"
                  >
                    <span className="font-mono text-[11px] font-semibold text-accent-lineage">{ex.token}</span>
                    <span className="text-[10px] text-ink-muted">{ex.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
