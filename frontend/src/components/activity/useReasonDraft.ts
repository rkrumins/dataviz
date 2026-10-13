/**
 * The reason being typed for one change, and this person's recent ones.
 *
 * The dialog owns the draft (so it can clear it each time it opens) and takes
 * it when the change is confirmed. Taking a reason remembers it for that kind
 * of change, so someone who rebuilds the same source for the same reason
 * every week picks it from a chip instead of typing it again. Remembered in
 * this browser only: a convenience, not account data.
 */
import { useCallback, useState } from 'react'

import { useRecentSearches } from '@/hooks/useRecentSearches'

import type { ReasonContext } from './reasonPresets'

export interface ReasonDraft {
    context: ReasonContext
    value: string
    setValue: (value: string) => void
    reset: () => void
    /** The reason to send, remembered for next time — `undefined` when none was given. */
    take: () => string | undefined
    /** This person's recent reasons for this kind of change, newest first. */
    recent: string[]
}

export const REASON_MEMORY_PREFIX = 'nexus.activity.reasons.'

export function useReasonDraft(context: ReasonContext): ReasonDraft {
    const [value, setValue] = useState('')
    const { recents, record } = useRecentSearches(`${REASON_MEMORY_PREFIX}${context}`)
    const reset = useCallback(() => setValue(''), [])
    const take = useCallback(() => {
        const text = value.trim()
        if (!text) return undefined
        record(text)
        return text
    }, [value, record])
    return { context, value, setValue, reset, take, recent: recents }
}
