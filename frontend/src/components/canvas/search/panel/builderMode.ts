/**
 * builderMode — which editor the query card opens in: Form (the filter
 * cards, the way a query has always been built here), Sentence (the guided
 * builder, a click away), Code or Cypher.
 *
 * A person's own choice is remembered in this browser; until they make
 * one, the card opens in Form. The card remounts each time the Advanced
 * drawer closes, so the choice has to outlive it.
 */
import { useCallback, useSyncExternalStore } from 'react'


export type EditorMode = 'sentence' | 'form' | 'code' | 'cypher'

export const EDITOR_MODE_KEY = 'synodic.advancedSearch.editorMode'

/** The editor the card opens in until a person chooses another. */
const DEFAULT_EDITOR_MODE: EditorMode = 'form'

const isMode = (v: string | null): v is EditorMode =>
    v === 'sentence' || v === 'form' || v === 'code' || v === 'cypher'

// Every reader shares the one choice — the panel hides its one-line
// sentence while the Sentence builder already shows the query.
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
}
/** A choice this browser can't store: kept for the page's life instead. */
let unsaved: EditorMode | null = null

/** The editor this browser last chose, or null for none. "Visual" — the
 *  cards' name before Sentence existed — was the default rather than a
 *  choice, so it reads as none: the cards again. */
function savedEditorMode(): EditorMode | null {
    try {
        const saved = localStorage.getItem(EDITOR_MODE_KEY)
        return isMode(saved) ? saved : null
    } catch {
        return unsaved
    }
}

/** The editor to open in — the one this browser last chose, or Form —
 *  and how to choose another. */
export function useEditorMode(): [EditorMode, (next: EditorMode) => void] {
    const saved = useSyncExternalStore(subscribe, savedEditorMode, () => null)
    const update = useCallback((next: EditorMode) => {
        try { localStorage.setItem(EDITOR_MODE_KEY, next) } catch { unsaved = next }
        listeners.forEach((fn) => fn())
    }, [])
    return [saved ?? DEFAULT_EDITOR_MODE, update]
}
