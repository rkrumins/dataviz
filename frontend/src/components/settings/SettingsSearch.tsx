/**
 * SettingsSearch — find a setting by any word for it: its label, the words people use for it
 * ("staleness", "eviction"), a problem it answers ("Canvases are slow while an import lands"), its
 * env var or key. Each result says why it matched.
 *
 * A combobox: type, move through results with ↑ ↓, open one with Enter (the page scrolls to it),
 * Esc clears. `/` anywhere on the page (outside a text field) jumps here.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/Kbd'
import { CONTROL_SHELL, CONTROL_SIZE } from '@/components/ui/controlStyles'
import { searchSettings, type MatchField, type SearchHit } from './search'
import type { Category, Setting } from './types'

const WHY_MATCHED: Partial<Record<MatchField, string>> = {
    alias: 'Also called', symptom: 'Answers', env: 'Env var', key: 'Key', question: 'Asks', summary: 'About',
}

export function SettingsSearch({ settings, categories = [], onSelect, placeholder = 'Search settings, problems or env vars', shortcut = true, className }: {
    settings: Setting[]
    categories?: Category[]
    /** A result was chosen: show that setting. */
    onSelect: (key: string) => void
    placeholder?: string
    /** `/` focuses the search. */
    shortcut?: boolean
    className?: string
}) {
    const id = useId()
    const listId = `${id}-results`
    const input = useRef<HTMLInputElement>(null)
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const [open, setOpen] = useState(false)
    const hits = useMemo(() => searchSettings(settings, query), [settings, query])
    const showList = open && query.trim().length > 0

    useEffect(() => {
        if (!shortcut) return
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
            const t = e.target as HTMLElement | null
            if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
            e.preventDefault()
            input.current?.focus()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [shortcut])

    const choose = (hit: SearchHit) => {
        onSelect(hit.setting.key)
        setOpen(false)
    }

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!hits.length) return
            e.preventDefault()
            setOpen(true)
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length)
        } else if (e.key === 'Enter') {
            const hit = hits[active]
            if (showList && hit) {
                e.preventDefault()
                choose(hit)
            }
        } else if (e.key === 'Escape') {
            if (showList) setOpen(false)
            else setQuery('')
        }
    }

    const categoryLabel = (c: string) => categories.find((x) => x.id === c)?.label
    return (
        <div className={cn('relative', className)}>
            <div className={cn(CONTROL_SHELL, CONTROL_SIZE.md, 'pl-3 pr-2')}>
                <Search aria-hidden className="w-4 h-4 shrink-0 text-ink-muted" />
                <input
                    ref={input}
                    type="search"
                    role="combobox"
                    aria-label="Search settings"
                    aria-expanded={showList}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={showList && hits[active] ? `${id}-hit-${active}` : undefined}
                    placeholder={placeholder}
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value)
                        setActive(0)
                        setOpen(true)
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onKeyDown={onKeyDown}
                    className="h-full min-w-0 flex-1 bg-transparent px-2.5 outline-none placeholder:text-ink-muted [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                    <button type="button" aria-label="Clear the search" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery('')}
                        className="grid place-items-center w-6 h-6 rounded-md text-ink-muted hover:text-ink">
                        <X aria-hidden className="w-3.5 h-3.5" />
                    </button>
                ) : shortcut && <Kbd shortcut="/" />}
            </div>
            <ul
                id={listId}
                role="listbox"
                aria-label="Settings found"
                hidden={!showList}
                className={cn(
                    'absolute inset-x-0 top-full z-40 mt-1.5 max-h-96 overflow-y-auto rounded-2xl border border-glass-border/60 bg-canvas-elevated p-1.5',
                    'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]',
                )}
            >
                {hits.length === 0 && (
                    <li role="presentation" className="px-3 py-3 text-xs text-ink-muted">No setting matches “{query.trim()}”. Try a problem, like “slow canvases”.</li>
                )}
                {hits.map((hit, i) => (
                    <li
                        key={hit.setting.key}
                        id={`${id}-hit-${i}`}
                        role="option"
                        aria-selected={i === active}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(hit)}
                        className={cn('cursor-pointer rounded-xl px-3 py-2', i === active ? 'bg-black/[0.05] dark:bg-white/[0.07]' : '')}
                    >
                        <span className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-[13px] font-semibold text-ink">{hit.setting.label}</span>
                            {categoryLabel(hit.setting.category) && (
                                <span className="shrink-0 text-[11px] text-ink-muted">{categoryLabel(hit.setting.category)}</span>
                            )}
                        </span>
                        {WHY_MATCHED[hit.field] && (
                            <span className="mt-0.5 block truncate text-[11.5px] text-ink-muted">
                                {WHY_MATCHED[hit.field]}: <span className={cn('text-ink-secondary', (hit.field === 'env' || hit.field === 'key') && 'font-mono text-[11px]')}>{hit.text}</span>
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    )
}
