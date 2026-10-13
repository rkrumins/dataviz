/**
 * The create-a-key wizard's state: the draft, what each step needs before it
 * lets you on, a one-line summary of each for the stepper, the server's
 * preview of what the key will reach, and creating it.
 *
 * The preview is asked for once each time Review is entered, and abandoned if
 * you leave before it answers. It is keyed on the draft's contents, not on
 * the step, so it always describes what is on screen.
 *
 * Confirming with an identity provider leaves the page: the draft is parked
 * at Review (no password, no token — there are none yet) and the page brings
 * you back to it.
 */
import { useCallback, useEffect, useState } from 'react'

import {
    ApiKeyError,
    apiKeyService,
    type ApiKeyOptions,
    type ApiKeyPermissions,
    type ApiKeyPreview,
    type ApiKeyResources,
    type CreatedApiKey,
    type PreviewApiKeyBody,
} from '@/services/apiKeyService'
import {
    cidrProblem, customDateProblem, describePermissions, describeResources, expiryDays, expiryFields,
    expiryOptions, formatDay, type ExpiryChoice,
} from '../apiKeyFormat'
import { freshDraft, parkDraft, type ApiKeyDraft, type WizardStep } from '../apiKeyDraft'
import { keyExposure } from '../exposure'
import { presetById, presetPatch, type Preset } from '../presets'

export const STEPS: { id: WizardStep; title: string }[] = [
    { id: 'purpose', title: 'Purpose' },
    { id: 'reach', title: 'Reach' },
    { id: 'permissions', title: 'Permissions' },
    { id: 'safety', title: 'Safety' },
    { id: 'review', title: 'Review' },
]

export function resourcesOf(d: Pick<ApiKeyDraft, 'resourceMode' | 'workspaces' | 'views' | 'dataSources'>): ApiKeyResources {
    if (d.resourceMode === 'all') return 'all'
    if (d.resourceMode === 'workspaces') return { workspaces: d.workspaces, views: [], dataSources: [] }
    return { workspaces: [], views: d.views.map((v) => v.id), dataSources: d.dataSources.map((s) => s.id) }
}

/** What create sends, minus the password — and all the preview needs. */
function bodyOf(d: ApiKeyDraft): PreviewApiKeyBody {
    return {
        name: d.name.trim(),
        description: d.description.trim() || undefined,
        permissions: d.permissions,
        resources: resourcesOf(d),
        allowedCidrs: d.cidrs,
        ...expiryFields(d.expiry as ExpiryChoice, d.customDate),
    }
}

type PreviewState =
    | { key: string; status: 'loading' }
    | { key: string; status: 'ready'; data: ApiKeyPreview }
    | { key: string; status: 'error'; message: string }

export function useApiKeyWizard({ options, resumed }: {
    options: ApiKeyOptions
    /** A draft parked before an identity-provider sign-in. */
    resumed?: ApiKeyDraft | null
}) {
    const [draft, setDraft] = useState<ApiKeyDraft>(() => resumed ?? freshDraft(options))
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [passwordFailed, setPasswordFailed] = useState(false)
    const [refusedStepUp, setRefusedStepUp] = useState(false)
    const [created, setCreated] = useState<CreatedApiKey | null>(null)
    const [preview, setPreview] = useState<PreviewState | null>(null)

    const update = useCallback((patch: Partial<ApiKeyDraft>) => setDraft((d) => ({ ...d, ...patch })), [])
    const setStep = useCallback((step: WizardStep) => update({ step }), [update])

    const max = options.policy.maxLifetimeDays
    const stepUpAvailable = options.stepUpAvailable && !refusedStepUp
    const viaProvider = options.stepUp.method === 'sso' && !options.stepUp.fresh

    const pickPreset = useCallback((preset: Preset) => update(presetPatch(preset, max)), [update, max])

    /** Publishing rides on changing views, so it goes when that does. */
    const setPermissions = useCallback((patch: Partial<ApiKeyPermissions>) => setDraft((d) => {
        const permissions = { ...d.permissions, ...patch }
        if (permissions.views !== 'write') permissions.publish = false
        return { ...d, permissions }
    }), [])

    // ── The server's preview, once per visit to Review ──────────────
    const reviewing = draft.step === 'review'
    // The draft without its step: what the preview is OF. A string, so
    // moving between steps with nothing changed is not a change.
    const content = JSON.stringify({ ...draft, step: null })
    useEffect(() => {
        if (!reviewing) return
        const abort = new AbortController()
        apiKeyService.preview(bodyOf(JSON.parse(content) as ApiKeyDraft), abort.signal)
            .then((data) => setPreview({ key: content, status: 'ready', data }))
            .catch((err: unknown) => {
                if (abort.signal.aborted) return
                setPreview({ key: content, status: 'error', message: err instanceof Error ? err.message : 'No preview.' })
            })
        return () => abort.abort()
    }, [reviewing, content])
    const previewState: PreviewState | null = !reviewing ? null
        : preview?.key === content ? preview : { key: content, status: 'loading' }

    // ── What each step needs ─────────────────────────────────────────
    const validCidrs = draft.cidrs.every((c) => !cidrProblem(c))
    const dateProblem = draft.expiry === 'custom' ? customDateProblem(draft.customDate, max) : null
    const valid: Record<WizardStep, boolean> = {
        purpose: draft.preset !== null && draft.name.trim().length > 0,
        reach: draft.resourceMode === 'all'
            || (draft.resourceMode === 'workspaces' && draft.workspaces.length > 0)
            || (draft.resourceMode === 'items' && draft.views.length + draft.dataSources.length > 0),
        permissions: draft.permissions.views !== 'none' || draft.permissions.data !== 'none',
        safety: dateProblem === null && validCidrs,
        review: stepUpAvailable && (options.stepUp.method !== 'password' || password.length > 0),
    }

    const expiry = expiryOptions(max).find((o) => o.value === draft.expiry)
    const summaries: Record<WizardStep, string | null> = {
        purpose: draft.name.trim() || presetById(draft.preset)?.title || null,
        reach: describeResources(resourcesOf(draft)),
        permissions: describePermissions(draft.permissions),
        safety: `${draft.expiry === 'custom' ? `until ${formatDay(`${draft.customDate}T12:00:00Z`)}` : expiry?.label ?? ''} · ${draft.cidrs.length > 0
            ? `${draft.cidrs.length} network${draft.cidrs.length === 1 ? '' : 's'}`
            : 'any network'}`,
        review: null,
    }

    const exposure = keyExposure({
        permissions: draft.permissions,
        resourceMode: draft.resourceMode,
        lifetimeDays: expiryDays(draft.expiry as ExpiryChoice, draft.customDate),
        cidrs: draft.cidrs,
    })

    const submit = useCallback(async () => {
        setBusy(true)
        setError(null)
        setPasswordFailed(false)
        try {
            const result = await apiKeyService.create({
                ...bodyOf(draft),
                currentPassword: options.stepUp.method === 'password' ? password : undefined,
            })
            setPassword('')
            setCreated(result)
        } catch (err) {
            if (err instanceof ApiKeyError && err.code === 'step_up_required' && err.method === 'sso' && err.loginUrl) {
                parkDraft({ ...draft, step: 'review' })
                window.location.href = err.loginUrl
                return
            }
            if (err instanceof ApiKeyError && err.code === 'step_up_unavailable') {
                setRefusedStepUp(true)
            } else if (err instanceof ApiKeyError && err.code === 'step_up_failed') {
                setPasswordFailed(true)
                setPassword('')
            } else {
                setError(err instanceof Error ? err.message : 'The key could not be created.')
            }
        } finally {
            setBusy(false)
        }
    }, [draft, options.stepUp.method, password])

    return {
        draft,
        update,
        step: draft.step,
        setStep,
        pickPreset,
        setPermissions,
        password,
        setPassword,
        passwordFailed,
        stepUpAvailable,
        viaProvider,
        busy,
        error,
        created,
        preview: previewState,
        canAdvance: valid[draft.step],
        valid,
        summaries,
        dateProblem,
        exposure,
        dirty: draft.preset !== null || draft.name.trim() !== '',
        submitLabel: viaProvider ? 'Continue with your identity provider' : 'Create key',
        submit,
    }
}

export type ApiKeyWizardState = ReturnType<typeof useApiKeyWizard>
