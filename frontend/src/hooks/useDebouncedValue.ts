/**
 * useDebouncedValue — returns `value` after it has been stable for `delayMs`.
 *
 * Extracted from useGlobalSearch so every search box on the Ontology page
 * (and elsewhere) shares one implementation instead of filtering on each
 * keystroke.
 */
import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value)
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delayMs)
        return () => clearTimeout(t)
    }, [value, delayMs])
    return debounced
}
