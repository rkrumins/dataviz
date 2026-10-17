/**
 * The two things a text field on the filter bar needs beyond typing.
 *
 * `useDebouncedCommit` writes its value back a moment after typing stops, or
 * at once with `flush`. A change from elsewhere (Clear, a drill-in) replaces
 * what the field shows, but its own commit never does: typing on while the
 * last word is being applied must not lose the letters typed since.
 *
 * `useSuggestions` is the combobox pattern for the picks shown under a field:
 * ↑/↓ move through them, Enter takes one, and focus never leaves the field.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { useDebouncedValue } from '@/hooks/useDebouncedValue'

export function useDebouncedCommit(value: string, onCommit: (value: string) => void, delayMs = 350) {
    const [text, setText] = useState(value)
    const committed = useRef(value)
    const debounced = useDebouncedValue(text, delayMs)

    useEffect(() => {
        if (value !== committed.current) {
            committed.current = value
            setText(value)
        }
    }, [value])

    useEffect(() => {
        if (debounced !== committed.current) {
            committed.current = debounced
            onCommit(debounced)
        }
    }, [debounced, onCommit])

    const flush = useCallback((next: string) => {
        setText(next)
        committed.current = next
        onCommit(next)
    }, [onCommit])

    return [text, setText, flush] as const
}

export function useSuggestions<T>({ items, open, onPick }: {
    items: readonly T[]
    open: boolean
    onPick: (item: T) => void
}) {
    const listId = useId()
    const [rawActive, setActive] = useState(-1)
    const active = open && rawActive < items.length ? rawActive : -1
    const optionId = (i: number) => `${listId}-option-${i}`

    return {
        active,
        /** Nothing chosen: call when the list changes under the pointer. */
        reset: () => setActive(-1),
        /** Handles ↑/↓ and Enter-on-a-pick; true when it did. */
        onKeyDown: (e: React.KeyboardEvent): boolean => {
            if (!open || items.length === 0) return false
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setActive((items.length + (active < 0 && step < 0 ? 0 : active) + step) % items.length)
                return true
            }
            if (e.key === 'Enter' && active >= 0) {
                e.preventDefault()
                onPick(items[active])
                return true
            }
            return false
        },
        inputProps: {
            role: 'combobox' as const,
            'aria-expanded': open,
            'aria-controls': listId,
            'aria-autocomplete': 'list' as const,
            'aria-activedescendant': active >= 0 ? optionId(active) : undefined,
        },
        listProps: { id: listId, role: 'listbox' as const },
        optionProps: (i: number) => ({
            id: optionId(i),
            role: 'option' as const,
            'aria-selected': i === active,
            // Keep focus in the field: a pick should not blur it first.
            onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
            onMouseEnter: () => setActive(i),
            onClick: () => onPick(items[i]),
        }),
    }
}
