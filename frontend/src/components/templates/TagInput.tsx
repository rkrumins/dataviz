/**
 * TagInput — chip-style multi-value input.
 *
 * Enter or "," adds the current value as a tag. Backspace on an empty
 * input removes the last tag. The "×" on each chip removes it. An
 * optional `suggestions` array drives a datalist for autocompletion
 * across already-used tags in the gallery.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'

interface TagInputProps {
    value: string[]
    onChange: (next: string[]) => void
    suggestions?: string[]
    placeholder?: string
    id?: string
}

export function TagInput({
    value, onChange, suggestions, placeholder, id,
}: TagInputProps) {
    const [draft, setDraft] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)
    const datalistId = `${id ?? 'taginput'}-suggestions`

    const commit = (raw: string) => {
        const cleaned = raw.trim().toLowerCase()
        if (!cleaned) return
        if (value.includes(cleaned)) {
            setDraft('')
            return
        }
        onChange([...value, cleaned])
        setDraft('')
    }

    const removeAt = (idx: number) => {
        const next = value.slice()
        next.splice(idx, 1)
        onChange(next)
    }

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
            return
        }
        if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            removeAt(value.length - 1)
        }
    }

    return (
        <div
            className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg bg-canvas border border-glass-border focus-within:border-accent-lineage/50 focus-within:ring-1 focus-within:ring-accent-lineage/30 transition-colors"
            onClick={() => inputRef.current?.focus()}
        >
            {value.map((tag, i) => (
                <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-accent-lineage/10 text-accent-lineage"
                >
                    {tag}
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeAt(i) }}
                        className="hover:text-accent-lineage/70"
                        aria-label={`Remove ${tag}`}
                    >
                        <X className="w-3 h-3" />
                    </button>
                </span>
            ))}
            <input
                ref={inputRef}
                id={id}
                list={suggestions && suggestions.length > 0 ? datalistId : undefined}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => draft && commit(draft)}
                placeholder={value.length === 0 ? (placeholder ?? 'Add a tag…') : ''}
                className="flex-1 min-w-[80px] bg-transparent text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none px-1 py-0.5"
            />
            {suggestions && suggestions.length > 0 && (
                <datalist id={datalistId}>
                    {suggestions.filter(s => !value.includes(s.toLowerCase())).map(s => (
                        <option key={s} value={s} />
                    ))}
                </datalist>
            )}
        </div>
    )
}
