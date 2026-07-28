/**
 * Client-side password strength, shared by every screen that takes one.
 *
 * The loader, the two palettes and the 300ms debounce were duplicated
 * byte-for-byte between SignUpPage and ResetPasswordPage. The account
 * page would have been the third copy, at which point they stop being
 * duplicates and start being three things that drift.
 *
 * Only the logic is shared. The markup around it deliberately is not —
 * the pages present the meter differently, and a component with enough
 * props to reproduce all of them would be harder to read than the three
 * short blocks of JSX it replaced.
 *
 * The score mirrors the server's zxcvbn check (`_check_password_strength`
 * rejects below 3), so the form can refuse a password before the round
 * trip rather than after it.
 */
import { useEffect, useState } from 'react'

let zxcvbnInstance: import('@zxcvbn-ts/core').ZxcvbnFactory | null = null

/** Dictionaries are ~400KB, so they load on first keystroke, not on boot. */
async function loadZxcvbn() {
    if (zxcvbnInstance) return zxcvbnInstance
    const [core, langCommon, langEn] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
    ])
    zxcvbnInstance = new core.ZxcvbnFactory({
        translations: langEn.translations,
        graphs: langCommon.adjacencyGraphs,
        dictionary: {
            ...langCommon.dictionary,
            ...langEn.dictionary,
        },
    })
    return zxcvbnInstance
}

export const STRENGTH_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-400', 'bg-green-500']
export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong']

/** The score the server will also insist on. */
export const MIN_STRENGTH_SCORE = 3

export interface PasswordStrength {
    /** 0-4 once scored; -1 while empty or not yet scored. */
    score: number
    /** zxcvbn's warning and suggestions, joined. Empty when it has none. */
    feedback: string
}

/**
 * Score a password, debounced.
 *
 * Returns -1 until there is something to score, which is the sentinel
 * every caller's `score >= 3` gate was already written against.
 */
export function usePasswordStrength(password: string): PasswordStrength {
    const [score, setScore] = useState(-1)
    const [feedback, setFeedback] = useState('')

    useEffect(() => {
        if (!password) {
            setScore(-1)
            setFeedback('')
            return
        }
        let cancelled = false
        const timer = setTimeout(async () => {
            const zxcvbn = await loadZxcvbn()
            if (cancelled) return
            const result = zxcvbn.check(password)
            setScore(result.score)
            const fb = result.feedback
            const parts: string[] = []
            if (fb.warning) parts.push(fb.warning)
            if (fb.suggestions?.length) parts.push(...fb.suggestions)
            setFeedback(parts.join(' '))
        }, 300)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [password])

    return { score, feedback }
}
