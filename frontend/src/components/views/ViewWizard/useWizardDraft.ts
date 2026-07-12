/**
 * useWizardDraft — never lose 20 minutes of layer assignments to a stray click.
 *
 * Building a view on a large graph is real work (assignments, layers, groups).
 * Closing the modal — deliberately or not — used to throw all of it away. This
 * autosaves the in-progress form per scope and offers to resume it next time.
 *
 * CREATE MODE ONLY, deliberately. Resuming stale local edits over a view that
 * lives on the server (and may have been changed by someone else since) is a
 * data-integrity trap, not a convenience — edit mode always hydrates from the
 * server.
 *
 * The draft is cleared on successful creation, never on plain close: surviving a
 * close is the entire point.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WizardFormData, WizardStep } from './ViewWizard'

const KEY_PREFIX = 'viz-view-wizard-draft'
const SAVE_DEBOUNCE_MS = 800
const MAX_DRAFT_BYTES = 1_500_000     // a partial draft is worse than none
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface DraftEnvelope {
    v: 1
    savedAt: string
    step: WizardStep
    data: Omit<WizardFormData, 'isValid'>
}

export interface PendingDraft {
    savedAt: string
    step: WizardStep
    data: Partial<WizardFormData>
}

export function draftKey(scope: {
    workspaceId: string
    dataSourceId?: string | null
    providerId?: string | null
    ontologyId?: string | null
}): string {
    const target = scope.dataSourceId
        ? scope.dataSourceId
        : `blank:${scope.providerId ?? '-'}:${scope.ontologyId ?? '-'}`
    return `${KEY_PREFIX}:${scope.workspaceId}:${target}`
}

/** A draft with nothing in it isn't worth offering to restore. */
function isWorthResuming(data: Partial<WizardFormData>): boolean {
    return !!data.name?.trim()
        || (data.layers?.length ?? 0) > 0
        || Object.keys(data.assignments ?? {}).length > 0
}

export function useWizardDraft(opts: {
    /** create mode + still on the form (not mid-create) */
    enabled: boolean
    scopeKey: string
    formData: WizardFormData
    currentStep: WizardStep
}): {
    pendingDraft: PendingDraft | null
    dismissDraft: () => void
    clearDraft: () => void
    markDirty: () => void
    tooLarge: boolean
} {
    const { enabled, scopeKey, formData, currentStep } = opts

    const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null)
    const [tooLarge, setTooLarge] = useState(false)
    // Only write once the user has actually touched the form — otherwise the
    // freshly-initialised empty form would clobber the very draft we're offering
    // to restore.
    const dirtyRef = useRef(false)
    // While the resume banner is up, the decision is the user's to make.
    const undecidedRef = useRef(false)

    // ── Offer an existing draft on mount (per scope) ──
    useEffect(() => {
        if (!enabled) return
        dirtyRef.current = false
        try {
            const raw = localStorage.getItem(scopeKey)
            if (!raw) return
            const parsed = JSON.parse(raw) as DraftEnvelope
            if (parsed.v !== 1) return
            if (Date.now() - new Date(parsed.savedAt).getTime() > MAX_AGE_MS) {
                localStorage.removeItem(scopeKey)
                return
            }
            if (!isWorthResuming(parsed.data)) return
            undecidedRef.current = true
            setPendingDraft({ savedAt: parsed.savedAt, step: parsed.step, data: parsed.data })
        } catch {
            // Corrupt/unreadable draft — drop it rather than block the wizard.
            try { localStorage.removeItem(scopeKey) } catch { /* storage disabled */ }
        }
    }, [enabled, scopeKey])

    // ── Autosave (debounced) ──
    useEffect(() => {
        if (!enabled || !dirtyRef.current || undecidedRef.current) return

        const t = setTimeout(() => {
            const { isValid: _isValid, ...data } = formData
            const envelope: DraftEnvelope = {
                v: 1,
                savedAt: new Date().toISOString(),
                step: currentStep,
                data,
            }
            try {
                const payload = JSON.stringify(envelope)
                if (payload.length > MAX_DRAFT_BYTES) {
                    setTooLarge(true)
                    return
                }
                localStorage.setItem(scopeKey, payload)
                setTooLarge(false)
            } catch {
                // Quota exceeded / storage disabled — autosave is best-effort.
                setTooLarge(true)
            }
        }, SAVE_DEBOUNCE_MS)

        return () => clearTimeout(t)
    }, [enabled, scopeKey, formData, currentStep])

    const markDirty = useCallback(() => { dirtyRef.current = true }, [])

    const dismissDraft = useCallback(() => {
        undecidedRef.current = false
        setPendingDraft(null)
    }, [])

    const clearDraft = useCallback(() => {
        undecidedRef.current = false
        setPendingDraft(null)
        try { localStorage.removeItem(scopeKey) } catch { /* storage disabled */ }
    }, [scopeKey])

    return { pendingDraft, dismissDraft, clearDraft, markDirty, tooLarge }
}
