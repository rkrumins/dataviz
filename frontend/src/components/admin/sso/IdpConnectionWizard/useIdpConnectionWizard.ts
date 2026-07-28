/**
 * State for the connection wizard, kept out of the view.
 *
 * Mirrors ``useInviteWizard``: one hook owns the answers, whether the
 * current step may advance, and the async calls; the component owns the
 * chrome. Splitting them is what lets the step order be tested without
 * rendering five screens of layout.
 *
 * The ordering rule the whole flow rests on: **you cannot publish what you
 * have not rehearsed.** `canAdvance` refuses to leave the rehearse step
 * until a dry-run has actually come back, which is what makes "nothing is
 * live until you press publish" a guarantee rather than a slogan.
 */
import { useCallback, useMemo, useState } from 'react'
import {
    ssoAdminService,
    type IdpProvider,
    type DiscoverResult,
} from '@/services/ssoAdminService'
import { presetById, type VendorPreset } from '../vendorPresets'

export type WizardStep = 'choose' | 'connect' | 'map' | 'rehearse' | 'publish'

export const WIZARD_STEPS: WizardStep[] = [
    'choose', 'connect', 'map', 'rehearse', 'publish',
]

/** Slug from a display name: what the operator typed, URL-safe. Shown so
 *  they can see the redirect URI take shape while they type. */
export function slugify(name: string): string {
    return name.toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
}

export function useIdpConnectionWizard() {
    const [step, setStep] = useState<WizardStep>('choose')

    const [presetId, setPresetId] = useState<string | null>(null)
    const [displayName, setDisplayName] = useState('')
    const [connectInput, setConnectInput] = useState('')
    const [settings, setSettings] = useState<Record<string, unknown>>({})
    const [claimMapping, setClaimMapping] = useState<Record<string, unknown>>({})

    const [discovering, setDiscovering] = useState(false)
    const [discovery, setDiscovery] = useState<DiscoverResult | null>(null)

    const [saving, setSaving] = useState(false)
    const [provider, setProvider] = useState<IdpProvider | null>(null)
    const [rehearsed, setRehearsed] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const preset: VendorPreset | undefined = presetId
        ? presetById(presetId) : undefined
    const slug = useMemo(() => slugify(displayName), [displayName])

    /** Choosing a vendor seeds everything downstream. Re-choosing resets
     *  the mapping too — leaving Entra's claim names on an Okta connection
     *  is the exact mistake the presets exist to prevent. */
    const choose = useCallback((id: string) => {
        const p = presetById(id)
        setPresetId(id)
        setClaimMapping(p ? { ...p.claimMapping } : {})
        setDiscovery(null)
        setSettings({})
        if (!displayName && p) setDisplayName(p.name)
    }, [displayName])

    const runDiscovery = useCallback(async () => {
        if (!preset || !connectInput.trim()) return
        setDiscovering(true)
        setError(null)
        try {
            const looksLikeXml = connectInput.trim().startsWith('<')
            const result = await ssoAdminService.discover({
                kind: preset.kind,
                ...(preset.kind === 'saml2'
                    ? (looksLikeXml
                        ? { metadataXml: connectInput }
                        : { metadataUrl: connectInput })
                    : { issuer: connectInput }),
            })
            setDiscovery(result)
            if (result.success) {
                setSettings(prev => ({ ...prev, ...result.settings }))
            }
        } catch (err) {
            // A probe failure is a result, not a crash — but a transport
            // failure still needs saying out loud.
            setError((err as Error).message)
        } finally {
            setDiscovering(false)
        }
    }, [preset, connectInput])

    /** Create the row as a draft. Called on the way into `rehearse`,
     *  because a dry-run needs something with an id to rehearse against. */
    const createDraft = useCallback(async (): Promise<IdpProvider | null> => {
        if (provider || !preset) return provider
        setSaving(true)
        setError(null)
        try {
            const row = await ssoAdminService.createProvider({
                slug, displayName, kind: preset.kind,
                settings, claimMapping,
            })
            setProvider(row)
            return row
        } catch (err) {
            setError((err as Error).message)
            return null
        } finally {
            setSaving(false)
        }
    }, [provider, preset, slug, displayName, settings, claimMapping])

    const publish = useCallback(async (): Promise<boolean> => {
        if (!provider) return false
        setSaving(true)
        setError(null)
        try {
            setProvider(await ssoAdminService.publishProvider(provider.id))
            return true
        } catch (err) {
            setError((err as Error).message)
            return false
        } finally {
            setSaving(false)
        }
    }, [provider])

    const canAdvance = useMemo(() => {
        switch (step) {
            case 'choose':
                return Boolean(presetId)
            case 'connect':
                // A name is required — it becomes the slug, which is baked
                // into the redirect URI registered at the IdP. Discovery is
                // not: an operator with the values to hand may type them.
                return Boolean(displayName.trim() && slug)
            case 'map':
                // The two fields the backend refuses to resolve without.
                return Boolean(
                    (claimMapping.external_id as string[] | undefined)?.length &&
                    (claimMapping.email as string[] | undefined)?.length,
                )
            case 'rehearse':
                // The guarantee. Publishing something nobody has signed in
                // through is how a broken IdP reaches every user at once.
                return rehearsed
            case 'publish':
                return true
        }
    }, [step, presetId, displayName, slug, claimMapping, rehearsed])

    return {
        step, setStep,
        preset, presetId, choose,
        displayName, setDisplayName, slug,
        connectInput, setConnectInput,
        settings, setSettings,
        claimMapping, setClaimMapping,
        discovering, discovery, runDiscovery,
        saving, provider, createDraft, publish,
        rehearsed, setRehearsed,
        error, setError,
        canAdvance,
    }
}
