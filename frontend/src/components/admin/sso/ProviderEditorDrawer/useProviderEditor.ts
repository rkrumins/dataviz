/**
 * State for the provider editor, kept out of the view.
 *
 * Three things the old inline form did not do, and each is why this is a
 * hook rather than a pile of `useState` in the component:
 *
 *   **Dirty tracking.** The form had none, so closing it discarded work
 *   silently. Every field is diffed against the row it opened with, which
 *   also lets the footer say *how much* is unsaved rather than just that
 *   something is.
 *
 *   **Validation as you type.** Errors used to arrive as a red banner
 *   after Save — including a JSON parse failure, which meant a typo cost a
 *   round trip. Here they resolve continuously and name the section they
 *   are in, so the rail can point at them.
 *
 *   **Secret discipline.** The API returns `********` for configured
 *   secrets and PATCH *merges*, so submitting the mask would write it over
 *   the real value. `cleanSettings` strips it on the way out, which is why
 *   leaving a secret alone is the default and rotating is deliberate.
 */
import { useCallback, useMemo, useState } from 'react'
import {
    ssoAdminService,
    type IdpKind,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { REDACTED } from '../settings'

export type EditorSection =
    'identity' | 'connection' | 'mapping' | 'appearance' | 'danger'

export type LinkingPolicy =
    'strict' | 'allow_verified' | 'manual_only' | 'disabled'

/** Comma/space separated -> the array the API takes. The server normalises
 *  case and a leading @, so this only has to split. */
export function parseDomains(raw: string): string[] {
    return raw.split(/[,\s]+/).map(d => d.trim()).filter(Boolean)
}

/** Drop redacted secrets so a PATCH never writes the mask over the real
 *  value, and drop empties so the merge does not store noise. */
export function cleanSettings(
    s: Record<string, unknown>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(s).filter(([, v]) => v !== REDACTED && v !== ''),
    )
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

export interface EditorErrors {
    slug?: string
    displayName?: string
    buttonIcon?: string
}

interface Draft {
    displayName: string
    settings: Record<string, unknown>
    claimMapping: Record<string, unknown>
    linkingPolicy: LinkingPolicy
    emailDomains: string
    buttonLabel: string
    buttonIcon: string
    priority: number
    enabled: boolean
}

function draftOf(p: IdpProvider): Draft {
    return {
        displayName: p.displayName ?? '',
        settings: { ...(p.settings ?? {}) },
        claimMapping: { ...(p.claimMapping ?? {}) },
        linkingPolicy: (p.linkingPolicy ?? 'strict') as LinkingPolicy,
        emailDomains: (p.emailDomains ?? []).join(', '),
        buttonLabel: p.buttonLabel ?? '',
        buttonIcon: p.buttonIcon ?? '',
        priority: p.priority ?? 100,
        enabled: Boolean(p.enabled),
    }
}

/** Field-by-field, so the footer can count rather than just flag. */
function changedFields(a: Draft, b: Draft): string[] {
    const out: string[] = []
    for (const k of Object.keys(a) as (keyof Draft)[]) {
        const same = typeof a[k] === 'object'
            ? JSON.stringify(a[k]) === JSON.stringify(b[k])
            : a[k] === b[k]
        if (!same) out.push(k)
    }
    return out
}

export function useProviderEditor(provider: IdpProvider) {
    const original = useMemo(() => draftOf(provider), [provider])
    const [draft, setDraft] = useState<Draft>(original)
    const [section, setSection] = useState<EditorSection>('identity')
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => {
        setDraft(d => ({ ...d, [k]: v }))
    }, [])

    const changed = useMemo(
        () => changedFields(original, draft), [original, draft],
    )
    const dirty = changed.length > 0

    const errors = useMemo<EditorErrors>(() => {
        const e: EditorErrors = {}
        if (!draft.displayName.trim()) {
            e.displayName = 'A connection needs a name.'
        }
        if (draft.buttonIcon && /^https?:\/\//i.test(draft.buttonIcon)) {
            // The server refuses this too — but finding out at Save time,
            // after everything else was typed, is the worse way to learn it.
            e.buttonIcon =
                'Remote URLs are blocked by the content-security policy and ' +
                'would render as a broken image. Use a data: URI or a path ' +
                'on this server.'
        }
        return e
    }, [draft])

    const valid = Object.keys(errors).length === 0

    /** Which sections currently hold a problem, so the rail can say so
     *  rather than making the operator hunt for it. */
    const sectionErrors = useMemo<Partial<Record<EditorSection, number>>>(() => {
        const out: Partial<Record<EditorSection, number>> = {}
        if (errors.displayName) out.identity = (out.identity ?? 0) + 1
        if (errors.buttonIcon) out.appearance = (out.appearance ?? 0) + 1
        return out
    }, [errors])

    const save = useCallback(async (): Promise<boolean> => {
        if (!valid) return false
        setSaving(true)
        setSaveError(null)
        try {
            await ssoAdminService.updateProvider(provider.id, {
                displayName: draft.displayName,
                settings: cleanSettings(draft.settings),
                claimMapping: draft.claimMapping,
                linkingPolicy: draft.linkingPolicy,
                emailDomains: parseDomains(draft.emailDomains),
                buttonLabel: draft.buttonLabel || null,
                buttonIcon: draft.buttonIcon || null,
                priority: draft.priority,
                enabled: draft.enabled,
            })
            return true
        } catch (err) {
            setSaveError((err as Error).message)
            return false
        } finally {
            setSaving(false)
        }
    }, [provider.id, draft, valid])

    return {
        draft, set,
        section, setSection,
        dirty, changedCount: changed.length,
        errors, sectionErrors, valid,
        saving, saveError, save,
        kind: provider.kind as IdpKind,
    }
}

export { SLUG_RE }
