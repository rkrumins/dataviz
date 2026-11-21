/**
 * TagInput — free-form tags as chips, with suggestions.
 *
 * Enter or a comma adds what was typed; Backspace in an empty box takes the last chip off.
 * The same tag in other letters is the same tag ("Finance" when "finance" is there adds
 * nothing). Suggestions are the tags already in use nearby, most used first (`rankTags`
 * in `lib/tags`),
 * offered as a listbox the arrow keys walk — the box is a combobox, so a screen reader
 * hears how many there are and which is active.
 */
import { useId, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { foldTag as fold } from '@/lib/tags'

const SHOWN = 8

const tidy = (t: string, maxLength: number) => t.trim().replace(/\s+/g, ' ').slice(0, maxLength)

export function TagInput({ id, value, onChange, suggestions = [], max = 20, maxLength = 40, placeholder = 'e.g. finance, month-end', label = 'Tags' }: {
    id?: string
    value: string[]
    onChange: (tags: string[]) => void
    /** Ranked, most used first — see `rankTags`. */
    suggestions?: string[]
    max?: number
    maxLength?: number
    placeholder?: string
    /** The chips' list and the box are named after it. */
    label?: string
}) {
    const autoId = useId()
    const inputId = id ?? `${autoId}-input`
    const listId = `${autoId}-list`
    const [text, setText] = useState('')
    const [focused, setFocused] = useState(false)
    const [active, setActive] = useState(-1)
    const full = value.length >= max

    const options = useMemo(() => {
        const chosen = new Set(value.map(fold))
        const q = fold(text.trim())
        const free = suggestions.filter(s => !chosen.has(fold(s)) && fold(s).includes(q))
        // What starts with the words typed comes before what merely contains them.
        return (q ? [...free.filter(s => fold(s).startsWith(q)), ...free.filter(s => !fold(s).startsWith(q))] : free).slice(0, SHOWN)
    }, [suggestions, value, text])
    const open = focused && !full && options.length > 0

    /** Adds each of `raws` that is new, in order, as far as the limit allows. */
    const add = (...raws: string[]) => {
        const next = [...value]
        for (const raw of raws) {
            const tag = tidy(raw, maxLength)
            if (!tag || next.length >= max || next.some(t => fold(t) === fold(tag))) continue
            next.push(tag)
        }
        if (next.length !== value.length) onChange(next)
        setText('')
        setActive(-1)
    }

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            if (open && active >= 0) add(options[active])
            else if (text.trim()) add(text)
        } else if (e.key === 'ArrowDown' && open) {
            e.preventDefault()
            setActive(i => (i + 1) % options.length)
        } else if (e.key === 'ArrowUp' && open) {
            e.preventDefault()
            setActive(i => (i <= 0 ? options.length - 1 : i - 1))
        } else if (e.key === 'Escape' && open) {
            e.stopPropagation()
            setFocused(false)
        } else if (e.key === 'Backspace' && !text && value.length > 0) {
            onChange(value.slice(0, -1))
        }
    }

    return (
        <div className="relative">
            <div
                onClick={() => document.getElementById(inputId)?.focus()}
                className={cn(
                    'flex min-h-[42px] w-full cursor-text flex-wrap items-center gap-1.5 rounded-xl border px-2.5 py-2 transition-shadow',
                    'border-glass-border bg-black/[0.03] dark:bg-white/[0.04]',
                    focused && 'border-accent-lineage/40 ring-2 ring-accent-lineage/30',
                )}
            >
                {value.length > 0 && (
                    <ul aria-label={label} className="contents">
                        {value.map(t => (
                            <li key={t} className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent-lineage/20 bg-accent-lineage/10 py-0.5 pl-2 pr-1 text-xs font-medium text-accent-lineage">
                                <span className="truncate">{t}</span>
                                <button type="button" onClick={e => { e.stopPropagation(); onChange(value.filter(x => x !== t)) }}
                                    aria-label={`Remove ${t}`} className="rounded-full p-0.5 hover:bg-accent-lineage/20">
                                    <X className="h-2.5 w-2.5" aria-hidden />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <input
                    id={inputId}
                    role="combobox"
                    aria-label={label}
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
                    autoComplete="off"
                    value={text}
                    maxLength={maxLength}
                    readOnly={full}
                    onChange={e => {
                        const v = e.target.value
                        if (v.includes(',')) {
                            const parts = v.split(',')
                            const rest = parts.pop() ?? ''
                            add(...parts)
                            setText(rest.trimStart())
                        } else {
                            setText(v)
                            setActive(-1)
                        }
                    }}
                    onKeyDown={onKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => { setFocused(false); if (text.trim()) add(text) }}
                    placeholder={full ? `${max} tags — the most there can be` : value.length ? 'Add another…' : placeholder}
                    className="min-w-[110px] flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none"
                />
            </div>
            <ul id={listId} role="listbox" aria-label={`Suggested ${label.toLowerCase()}`} hidden={!open}
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-black/[0.08] bg-canvas-elevated p-1 shadow-lg dark:border-white/[0.10]">
                {open && options.map((s, i) => (
                    <li key={s} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                        // Keep the focus in the box, so picking one is not also a blur.
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => add(s)}
                        onMouseEnter={() => setActive(i)}
                        className={cn('cursor-pointer rounded-lg px-2.5 py-1.5 text-sm text-ink',
                            i === active ? 'bg-accent-lineage/10 text-accent-lineage' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
                        {s}
                    </li>
                ))}
            </ul>
            <p className="mt-1 flex justify-between gap-2 text-[10px] text-ink-muted">
                <span>Press Enter or comma to add a tag.</span>
                <span className="tabular-nums">{value.length}/{max}</span>
            </p>
        </div>
    )
}
