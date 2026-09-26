/**
 * useValueSuggestions — the value picker's list for what is being typed.
 *
 * Asks the view's `suggestValues` (counted across every entity of the
 * view's types, `GET /search/values`) once the typing pauses, and keeps
 * showing the previous answer for the same property meanwhile — the picker
 * filters it locally, so the list never blanks between keystrokes. Null
 * until the first answer, and whenever the backend cannot say: the row
 * falls back to the discovery sample.
 */
import { useEffect, useState } from 'react'

import type { SearchValuesResult } from '@/types/search'

import type { ValueSuggester } from '../builder/useDiscovery'


const TYPING_PAUSE_MS = 200


export function useValueSuggestions(
    suggest: ValueSuggester | undefined, key: string, q: string,
): SearchValuesResult | null {
    const [answer, setAnswer] = useState<{ key: string; result: SearchValuesResult | null } | null>(null)
    useEffect(() => {
        if (!suggest || !key.trim()) return
        let live = true
        const timer = setTimeout(() => {
            void suggest(key, q).then((result) => {
                if (live) setAnswer({ key, result })
            })
        }, q ? TYPING_PAUSE_MS : 0)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [suggest, key, q])
    // Never another property's values.
    return answer && answer.key === key ? answer.result : null
}
