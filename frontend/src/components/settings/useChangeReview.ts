/**
 * useChangeReview — what a review asks before a save, wherever it is drawn (the review dialog, or
 * the guided setup's last step): a reason, each warning acknowledged, and the impact worked out.
 * `ready` once all of that is done; `blocking` says what is still missing.
 *
 * A new try at the impact asks again to save without it: that was agreed to for the one that
 * failed. A new `round` (the page's count of saves) starts afresh: an empty reason, nothing
 * acknowledged.
 */
import { useState, type ReactNode } from 'react'

export interface ReviewWarning {
    id: string
    text: ReactNode
    /** What ticking it says: "I understand" by default. */
    confirm?: string
}

/** The acknowledgement a failed impact asks for, among the warnings. */
const UNSEEN = 'impact_unavailable'
const UNSEEN_WARNING: ReviewWarning = {
    id: UNSEEN,
    text: 'What this changes couldn’t be worked out, so any warning it would raise isn’t shown here. The values are still checked when they are saved.',
    confirm: 'Save without seeing what this changes',
}

export interface ChangeReview {
    reason: string
    setReason: (reason: string) => void
    acknowledged: Record<string, boolean>
    acknowledge: (id: string, on: boolean) => void
    /** The warnings to acknowledge: those given and, when the impact failed, saving without it. */
    shown: ReviewWarning[]
    /** A reason, every warning acknowledged, the impact in, and nothing saving. */
    ready: boolean
    /** What Save waits for, in words; empty once it waits for nothing the person can do. */
    blocking: string
}

export function useChangeReview({ count, warnings, impactLoading = false, impactFailed = false, saving = false, round = 0 }: {
    /** How many changes are reviewed. */
    count: number
    /** Each must be acknowledged before saving. */
    warnings: ReviewWarning[]
    /** The impact is being worked out: Save waits for it, as its warnings aren't known yet. */
    impactLoading?: boolean
    /** The impact couldn't be worked out: Save needs "Save without seeing what this changes". */
    impactFailed?: boolean
    saving?: boolean
    /** Changes with each save: a new round starts with an empty reason, nothing acknowledged. */
    round?: number
}): ChangeReview {
    const [reason, setReason] = useState('')
    const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({})
    const [seenRound, setSeenRound] = useState(round)
    if (seenRound !== round) {
        setSeenRound(round)
        setReason('')
        setAcknowledged({})
    }
    const [wasLoading, setWasLoading] = useState(impactLoading)
    if (wasLoading !== impactLoading) {
        setWasLoading(impactLoading)
        if (impactLoading && acknowledged[UNSEEN]) setAcknowledged((a) => ({ ...a, [UNSEEN]: false }))
    }
    const shown = impactFailed && !impactLoading ? [...warnings, UNSEEN_WARNING] : warnings
    const unacknowledged = shown.filter((w) => !acknowledged[w.id]).length
    const ready = count > 0 && reason.trim().length > 0 && unacknowledged === 0 && !impactLoading && !saving
    const blocking = impactLoading
        ? 'Save waits for what this changes.'
        : !reason.trim()
            ? 'Say why to save.'
            : unacknowledged ? `Acknowledge ${unacknowledged === 1 ? 'the warning' : `${unacknowledged} warnings`} to save.` : ''
    return {
        reason,
        setReason,
        acknowledged,
        acknowledge: (id, on) => setAcknowledged((a) => ({ ...a, [id]: on })),
        shown,
        ready,
        blocking,
    }
}
